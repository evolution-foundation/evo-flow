import { BaseNode, NodeExecutionResult } from './base.node';

type ArithmeticOperation = 'increase' | 'decrease';

export interface SetVariableNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    variableName?: string;
    variableValue?: any;
    // What the panel can send, not what the runtime honors: only
    // set/increase/decrease are implemented, the rest fall through to a plain
    // SET (tracked separately).
    operation?:
      | 'set'
      | 'clear'
      | 'increase'
      | 'decrease'
      | 'now'
      | 'yesterday'
      | 'tomorrow'
      | 'time_of_day'
      | 'random_id';
    value?: any;
    category?: string;
    variables?: Array<{
      name: string;
      value: any;
    }>;
    nextNodeId?: string;
  };
}

export class SetVariableNode extends BaseNode {
  constructor() {
    super('SetVariable');
  }

  async execute(input: SetVariableNodeInput): Promise<NodeExecutionResult> {
    const startTime = Date.now();

    return await this.executeWithTiming(input.nodeId, input, async () => {
      const variablesToSet: Record<string, any> = {};

      // Log input for debugging
      this.logger.log('SetVariable input received', {
        nodeId: input.nodeId,
        nodeData: input.nodeData,
      });

      const operation = input.nodeData.operation ?? 'set';
      const isArithmetic =
        operation === 'increase' || operation === 'decrease';

      // increase/decrease is a read-modify-write; a plain SET must not hit the DB.
      const sessionVariables = isArithmetic
        ? await this.loadSessionVariables(input.sessionId)
        : {};

      // Support both single variable and multiple variables
      if (input.nodeData.variableName) {
        // Extract clean variable name from {{variableName}} format
        const cleanName = input.nodeData.variableName.replace(/^\{\{|\}\}$/g, '');
        // Use value or variableValue
        const value =
          input.nodeData.value !== undefined
            ? input.nodeData.value
            : input.nodeData.variableValue;

        variablesToSet[cleanName] = isArithmetic
          ? this.applyArithmetic(
              cleanName,
              value,
              operation as ArithmeticOperation,
              sessionVariables,
              input,
            )
          : value;

        this.logger.log('Setting single variable', {
          originalName: input.nodeData.variableName,
          cleanName,
          operation,
          value: variablesToSet[cleanName],
        });
      } else if (
        input.nodeData.variables &&
        Array.isArray(input.nodeData.variables)
      ) {
        // Multiple variables — the array shape carries the same node-level
        // `operation`, so it gets the same arithmetic.
        for (const variable of input.nodeData.variables) {
          const cleanName = String(variable.name).replace(/^\{\{|\}\}$/g, '');

          variablesToSet[cleanName] = isArithmetic
            ? this.applyArithmetic(
                cleanName,
                variable.value,
                operation as ArithmeticOperation,
                sessionVariables,
                input,
              )
            : variable.value;
        }
      }

      if (Object.keys(variablesToSet).length === 0) {
        this.logger.warn('No variables to set', {
          nodeId: input.nodeId,
          nodeData: input.nodeData,
        });

        return {
          variablesSet: {},
          variableCount: 0,
        };
      }

      // Process variable values (support dynamic values)
      const processedVariables: Record<string, any> = {};

      for (const [name, value] of Object.entries(variablesToSet)) {
        // Support template variables like {{contact.email}}, {{timestamp}}, etc.
        const processedValue = this.processVariableValue(value, {
          contactId: input.contactId,
          sessionId: input.sessionId,
          timestamp: new Date().toISOString(),
        });

        processedVariables[name] = processedValue;
      }

      this.logger.log('Variables set successfully', {
        nodeId: input.nodeId,
        contactId: input.contactId,
        variablesSet: processedVariables,
        variableCount: Object.keys(processedVariables).length,
      });

      return {
        variablesSet: processedVariables,
        variableCount: Object.keys(processedVariables).length,
      };
    })
      .then(({ result, executionTime }) => {
        // Add all set variables to the workflow context
        const variables: Record<string, any> = {
          [`node_${input.nodeId}_variables_count`]: result.variableCount,
        };

        // Add each variable to the context directly without prefix
        for (const [name, value] of Object.entries(result.variablesSet)) {
          variables[name] = value;
        }

        return this.createSuccessResult(input, executionTime, variables);
      })
      .catch((error) => {
        // Elapsed, not Date.now(): this feeds the node telemetry as a duration.
        return this.createErrorResult(error, Date.now() - startTime);
      });
  }

  private applyArithmetic(
    name: string,
    rawAmount: any,
    operation: ArithmeticOperation,
    sessionVariables: Record<string, any>,
    input: SetVariableNodeInput,
  ): number {
    // The Amount field accepts {{variables}} and the executor passes nodeData
    // raw, so resolve against the session before parsing.
    const resolvedAmount = this.processVariableValue(rawAmount, {
      ...sessionVariables,
      contactId: input.contactId,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
    });

    const delta = this.toFiniteNumber(resolvedAmount);
    if (delta === null) {
      throw new Error(
        `Set Variable ${operation} requires a numeric amount, got ${JSON.stringify(
          rawAmount,
        )}`,
      );
    }

    const base = this.resolveArithmeticBase(
      name,
      sessionVariables[name],
      operation,
    );

    return operation === 'increase' ? base + delta : base - delta;
  }

  // Unset starts at 0; a variable that holds a non-numeric value has no sane
  // arithmetic and must not be rebased to 0, which would destroy it.
  private resolveArithmeticBase(
    name: string,
    prior: any,
    operation: ArithmeticOperation,
  ): number {
    if (prior === undefined || prior === null || prior === '') {
      return 0;
    }

    const parsed = this.toFiniteNumber(prior);
    if (parsed === null) {
      throw new Error(
        `Set Variable ${operation} cannot be applied to "${name}": current value ${JSON.stringify(
          prior,
        )} is not numeric`,
      );
    }

    return parsed;
  }

  // Number('') and Number(null) are 0, so "no value" would read as a valid
  // amount; booleans coerce too. Treat all of them as not-a-number.
  private toFiniteNumber(value: any): number | null {
    if (value === undefined || value === null || value === '') {
      return null;
    }

    if (typeof value === 'boolean') {
      return null;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  // No catch on purpose: degrading to {} would rebase the counter to 0 and
  // write a wrong value as success.
  private async loadSessionVariables(
    sessionId: string,
  ): Promise<Record<string, any>> {
    return await this.readSessionVariables(sessionId);
  }

  private processVariableValue(value: any, context: Record<string, any>): any {
    // If not a string, return as is
    if (typeof value !== 'string') {
      return value;
    }

    // Process template variables
    let processedValue = value;

    // Replace {{variable}} patterns
    processedValue = processedValue.replace(
      /\{\{([^}]+)\}\}/g,
      (match, varPath) => {
        const pathParts = varPath.trim().split('.');
        let currentValue: any = context;

        for (const part of pathParts) {
          if (
            currentValue &&
            typeof currentValue === 'object' &&
            part in currentValue
          ) {
            currentValue = currentValue[part];
          } else {
            // Variable not found, keep original
            return match;
          }
        }

        return String(currentValue);
      },
    );

    return processedValue;
  }
}
