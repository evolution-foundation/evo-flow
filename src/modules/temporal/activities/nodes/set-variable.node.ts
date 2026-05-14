import { BaseNode, NodeExecutionResult } from './base.node';

export interface SetVariableNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    variableName?: string;
    variableValue?: any;
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
        const value = (input.nodeData as any).value !== undefined 
          ? (input.nodeData as any).value 
          : input.nodeData.variableValue;
        variablesToSet[cleanName] = value;
        
        this.logger.log('Setting single variable', {
          originalName: input.nodeData.variableName,
          cleanName,
          value,
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
