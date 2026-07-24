import { BaseNode, NodeExecutionResult } from './base.node';

type ArithmeticOperation = 'increase' | 'decrease';

export interface SetVariableNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    variableName?: string;
    variableValue?: any;
    // EVO-1840: the config UI (SetVariablePanel) sends `operation` + `value`; the
    // runtime declared neither, so `operation` was silently dropped and every op
    // became a plain SET. Declaring them removes the `as any` casts below.
    // NOTE: this union models what the panel can SEND, not what the runtime
    // honors. Only set / increase / decrease are implemented; clear, now,
    // yesterday, tomorrow, time_of_day and random_id still fall through to the
    // plain-SET branch (writing the raw `value`, usually '') — same
    // UI-promises-what-the-runtime-drops class as this card, tracked separately.
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

      // EVO-1840: increase/decrease is a read-modify-write, so it needs the
      // session's current values. Read once, and only when an arithmetic
      // operation is actually configured (a plain SET must not touch the DB).
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
        // Multiple variables. EVO-1840: the array form carries the same
        // node-level `operation`, so it gets the same arithmetic — otherwise
        // increase/decrease would keep silently degrading to a plain SET on this
        // input shape, which is the exact bug this card fixes.
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
        // executionTime is a DURATION everywhere else (it feeds
        // logNodeExecution/trackNodeExecution); this branch used to report
        // Date.now(), i.e. an epoch timestamp, as the node's duration.
        return this.createErrorResult(error, Date.now() - startTime);
      });
  }

  // EVO-1840: apply the numeric operation the UI offers. The runtime used to
  // ignore `operation` and do a plain SET, so "increase lead_score by 40" never
  // accumulated.
  private applyArithmetic(
    name: string,
    rawAmount: any,
    operation: ArithmeticOperation,
    sessionVariables: Record<string, any>,
    input: SetVariableNodeInput,
  ): number {
    // The panel's Amount field is a VariableInput WITH a variable picker, and
    // the executor hands the node its raw nodeData (no interpolation upstream),
    // so `{{bonus}}` arrives literal. Resolve it against the session before
    // parsing — otherwise a UI-supported config would abort the whole journey.
    const resolvedAmount = this.processVariableValue(rawAmount, {
      ...sessionVariables,
      contactId: input.contactId,
      sessionId: input.sessionId,
      timestamp: new Date().toISOString(),
    });

    const delta = this.toFiniteNumber(resolvedAmount);
    if (delta === null) {
      // EVO-1740 family: fail visibly instead of silently no-op'ing.
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

  // An unset variable legitimately starts at 0 (the first increment lands on the
  // delta itself). A variable that HOLDS a non-numeric value is different: there
  // is no sane arithmetic for it, and rebasing to 0 would silently destroy the
  // stored value while reporting success — AC#3 wants that visible.
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

  // Number('') and Number(null) are both 0, which would turn an empty/absent
  // Amount into a silent "increase by 0" reported as success (the panel even
  // renders 1 as the placeholder in that state). Treat "no value" — and
  // booleans, which Number() happily coerces — as not-a-number.
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

  // EVO-1840: read the session's current variables so increase/decrease can
  // apply arithmetic to the prior value. Deliberately NO catch here: unlike
  // conditional.node.ts (which degrades to {} so evaluation continues), a failed
  // read on a read-modify-write would rebase the counter to 0 and silently
  // clobber the accumulated value (lead_score 500 → 40) while reporting success
  // — the very silent-success class this card fixes (EVO-1740). Let it throw.
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
