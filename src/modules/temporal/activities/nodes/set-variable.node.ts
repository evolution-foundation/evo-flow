import { BaseNode, NodeExecutionResult } from './base.node';

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
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const variablesToSet: Record<string, any> = {};

      // Log input for debugging
      this.logger.log('SetVariable input received', {
        nodeId: input.nodeId,
        nodeData: input.nodeData,
      });

      // Support both single variable and multiple variables
      if (input.nodeData.variableName) {
        // Extract clean variable name from {{variableName}} format
        const cleanName = input.nodeData.variableName.replace(/^\{\{|\}\}$/g, '');
        // Use value or variableValue
        const value =
          input.nodeData.value !== undefined
            ? input.nodeData.value
            : input.nodeData.variableValue;
        const operation = input.nodeData.operation ?? 'set';

        if (operation === 'increase' || operation === 'decrease') {
          // EVO-1840: honor the numeric operation the UI offers. The runtime used
          // to ignore `operation` and do a plain SET, so "increase lead_score by
          // 40" never accumulated. Read the current value and apply arithmetic.
          const delta = Number(value);
          if (!Number.isFinite(delta)) {
            // EVO-1740 family: fail visibly instead of silently no-op'ing.
            throw new Error(
              `Set Variable ${operation} requires a numeric amount, got ${JSON.stringify(
                value,
              )}`,
            );
          }
          const sessionVariables = await this.loadSessionVariables(
            input.sessionId,
          );
          const priorRaw = Number(sessionVariables[cleanName]);
          // Unset or non-numeric prior value → treat as 0 (first increment lands
          // on the delta itself).
          const base = Number.isFinite(priorRaw) ? priorRaw : 0;
          variablesToSet[cleanName] =
            operation === 'increase' ? base + delta : base - delta;
        } else {
          variablesToSet[cleanName] = value;
        }

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
        // Multiple variables
        for (const variable of input.nodeData.variables) {
          variablesToSet[variable.name] = variable.value;
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
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  // EVO-1840: read the session's current variables so increase/decrease can apply
  // arithmetic to the prior value. Mirrors conditional.node.ts (EVO-1913): degrade
  // to {} on failure but log at ERROR so the cause is visible.
  private async loadSessionVariables(
    sessionId: string,
  ): Promise<Record<string, any>> {
    try {
      const dataSource = await this.initializeDatabase();
      const { JourneySession } = await import(
        '../../../journeys/entities/journey-session.entity'
      );
      const sessionRepository = dataSource.getRepository(JourneySession);

      const session = await sessionRepository.findOne({
        where: { id: sessionId },
      });

      return session?.variables || {};
    } catch (error: any) {
      this.logger.error('Failed to load session variables', {
        sessionId,
        error: error.message,
      });
      return {};
    }
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
