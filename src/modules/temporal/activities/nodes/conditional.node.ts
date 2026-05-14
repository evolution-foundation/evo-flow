import { BaseNode, NodeExecutionResult } from './base.node';

export interface ConditionalNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    paths: Array<{
      id: string;
      name: string;
      color?: string;
      conditions: Array<{
        id: string;
        type: 'trigger' | 'contact' | 'system' | 'custom';
        field: string;
        operator:
          | 'equals'
          | 'not_equals'
          | 'contains'
          | 'not_contains'
          | 'greater_than'
          | 'less_than'
          | 'starts_with'
          | 'ends_with'
          | 'is_empty'
          | 'is_not_empty';
        value: any;
        customVariable?: string;
      }>;
      logicalOperator: 'AND' | 'OR';
    }>;
    nextNodeId?: string; // Default fallback node
  };
}

export class ConditionalNode extends BaseNode {
  constructor() {
    super('Conditional');
  }

  async execute(input: ConditionalNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // For conditional nodes, we need to carefully interpolate only the expected values,
      // NOT the field names themselves, as they need to be preserved for evaluation
      const interpolatedNodeData = await this.selectiveInterpolateNodeData(
        input,
        input.nodeData,
      );

      const { paths } = interpolatedNodeData;

      if (!paths || paths.length === 0) {
        throw new Error('No conditional paths configured');
      }

      // Load contact data for evaluation
      const contactData = await this.loadContactData(input.contactId);

      // Load session variables
      const sessionVariables = await this.loadSessionVariables(input.sessionId);

      // Track path evaluations for analytics
      const pathEvaluations: Array<{
        pathId: string;
        pathName: string;
        conditions: any[];
        matched: boolean;
        evaluationTime: number;
      }> = [];

      // Evaluate each path in order
      for (const path of paths) {
        const pathResult = await this.evaluatePath(
          path,
          contactData,
          sessionVariables,
          input,
        );

        // Store evaluation result for tracking
        pathEvaluations.push({
          pathId: path.id,
          pathName: path.name,
          conditions: path.conditions || [],
          matched: pathResult.matched,
          evaluationTime: pathResult.evaluationTime,
        });

        if (pathResult.matched) {
          this.logger.log('Conditional path matched', {
            nodeId: input.nodeId,
            pathId: path.id,
            pathName: path.name,
            conditionsCount: path.conditions?.length || 0,
            evaluationTime: pathResult.evaluationTime,
          });

          return {
            matchedPath: path.id,
            pathName: path.name,
            nextNodeHandle: path.id, // This will be used by workflow to determine next node
            conditionsEvaluated: path.conditions?.length || 0,
            pathEvaluations, // Include evaluation data for potential tracking
          };
        }
      }

      // No path matched, use else/default path
      this.logger.log('No conditional paths matched, using default path', {
        nodeId: input.nodeId,
        pathsEvaluated: paths.length,
        totalEvaluationTime: pathEvaluations.reduce((sum, p) => sum + p.evaluationTime, 0),
      });

      return {
        matchedPath: 'else',
        pathName: 'Default/Else Path',
        nextNodeHandle: 'else',
        conditionsEvaluated: 0,
        pathEvaluations, // Include evaluation data even for else path
      };
    })
      .then(({ result, executionTime }) => {
        return {
          success: true,
          nextNodeHandle: result.nextNodeHandle,
          executionTime,
          variables: {
            [`node_${input.nodeId}_matched_path`]: result.matchedPath,
            [`node_${input.nodeId}_path_name`]: result.pathName,
            [`node_${input.nodeId}_conditions_evaluated`]:
              result.conditionsEvaluated,
          },
        };
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  /**
   * Evaluate a conditional path
   */
  private async evaluatePath(
    path: any,
    contactData: any,
    sessionVariables: Record<string, any>,
    input: ConditionalNodeInput,
  ): Promise<{ matched: boolean; evaluationTime: number }> {
    const startTime = Date.now();
    
    if (!path.conditions || path.conditions.length === 0) {
      return { matched: true, evaluationTime: Date.now() - startTime }; // No conditions means always match
    }

    const results: boolean[] = [];

    for (const condition of path.conditions) {
      const result = await this.evaluateCondition(
        condition,
        contactData,
        sessionVariables,
        input,
      );
      results.push(result);
    }

    // Apply logical operator
    let matched: boolean;
    if (path.logicalOperator === 'OR') {
      matched = results.some((r) => r);
    } else {
      // Default to AND
      matched = results.every((r) => r);
    }

    const evaluationTime = Date.now() - startTime;
    return { matched, evaluationTime };
  }

  /**
   * Evaluate a single condition
   */
  private async evaluateCondition(
    condition: any,
    contactData: any,
    sessionVariables: Record<string, any>,
    input: ConditionalNodeInput,
  ): Promise<boolean> {
    const { type, field, operator, value } = condition;

    // Resolve field value based on type
    let fieldValue: any;

    switch (type) {
      case 'contact':
        fieldValue = this.resolveContactField(field, contactData);
        break;
      case 'trigger': {
        fieldValue = this.resolveTriggerField(field, sessionVariables);
        break;
      }
      case 'system': {
        fieldValue = this.resolveSystemField(field);
        break;
      }
      case 'custom': {
        // For custom type, use customVariable field if available
        const variableField = condition.customVariable || field;
        fieldValue = this.resolveVariableField(variableField, sessionVariables);
        break;
      }
      default:
        this.logger.warn('Unknown condition type', {
          nodeId: input.nodeId,
          type,
          field,
        });
        return false;
    }

    // Debug logging for condition evaluation
    this.logger.log('Evaluating condition', {
      nodeId: input.nodeId,
      conditionId: condition.id || 'unknown',
      type,
      field,
      originalField: condition.field, // Show original field from condition
      operator,
      expectedValue: value,
      resolvedFieldValue: fieldValue,
      availableVariables: Object.keys(sessionVariables),
      // Show first 5 variables with values for debugging
      sampleVariables: Object.entries(sessionVariables)
        .slice(0, 5)
        .reduce((acc, [k, v]) => ({ ...acc, [k]: v }), {}),
    });

    // Perform comparison
    const result = this.compareValues(fieldValue, operator, value);

    this.logger.log('Condition evaluation result', {
      nodeId: input.nodeId,
      conditionId: condition.id || 'unknown',
      result,
      fieldValue,
      operator,
      expectedValue: value,
    });

    return result;
  }

  /**
   * Resolve contact field value
   */
  private resolveContactField(field: string, contactData: any): any {
    // Handle {{contact.field}} format
    const match = field.match(/\{\{contact\.([^}]+)\}\}/);
    if (match) {
      const fieldName = match[1];
      return contactData?.[fieldName];
    }

    // Direct field access
    return contactData?.[field];
  }

  /**
   * Resolve trigger field value
   */
  private resolveTriggerField(
    field: string,
    sessionVariables: Record<string, any>,
  ): any {
    // Handle {{event.field}} format
    const match = field.match(/\{\{event\.([^}]+)\}\}/);
    if (match) {
      const eventField = match[1];

      // Try different possible variable names for the event field
      const possibleNames = [
        `event_${eventField}`, // event_name
        `trigger_event_${eventField}`, // trigger_event_name
        eventField, // name
      ];

      for (const varName of possibleNames) {
        if (sessionVariables[varName] !== undefined) {
          return sessionVariables[varName];
        }
      }
    }

    // Handle direct field access (legacy)
    if (field.startsWith('event.')) {
      const eventField = field.replace('event.', '');

      // Check for trigger event data in session variables
      if (sessionVariables[`trigger_event_${eventField}`] !== undefined) {
        return sessionVariables[`trigger_event_${eventField}`];
      }

      // Fallback to direct lookup
      if (sessionVariables[`event_${eventField}`] !== undefined) {
        return sessionVariables[`event_${eventField}`];
      }
    }

    return undefined;
  }

  /**
   * Resolve system field value
   */
  private resolveSystemField(field: string): any {
    const now = new Date();

    switch (field) {
      case 'system.current_time':
        return now.toISOString();
      case 'system.current_day':
        return now.getDay(); // 0-6 (Sunday=0)
      case 'system.current_date':
        return now.toISOString().split('T')[0]; // YYYY-MM-DD
      default:
        return undefined;
    }
  }

  /**
   * Resolve variable field value
   */
  private resolveVariableField(
    field: string,
    sessionVariables: Record<string, any>,
  ): any {
    // Handle {{variableName}} format
    const match = field.match(/\{\{([^}]+)\}\}/);
    if (match) {
      const variableName = match[1];

      // Try direct variable name first (as used in our current system)
      if (sessionVariables[variableName] !== undefined) {
        return sessionVariables[variableName];
      }

      // Try journey_ prefixed variables
      if (sessionVariables[`journey_${variableName}`] !== undefined) {
        return sessionVariables[`journey_${variableName}`];
      }
    }

    // If no {{}} format, try direct access
    if (sessionVariables[field] !== undefined) {
      return sessionVariables[field];
    }

    return undefined;
  }

  /**
   * Compare two values using operator
   */
  private compareValues(
    fieldValue: any,
    operator: string,
    expectedValue: any,
  ): boolean {
    // Handle null/undefined values
    if (fieldValue == null) {
      return operator === 'not_equals' ? expectedValue != null : false;
    }

    // Convert to strings for comparison
    const fieldStr = String(fieldValue).toLowerCase();
    const expectedStr = String(expectedValue).toLowerCase();

    switch (operator) {
      case 'equals':
        return fieldStr === expectedStr;
      case 'not_equals':
        return fieldStr !== expectedStr;
      case 'contains':
        return fieldStr.includes(expectedStr);
      case 'not_contains':
        return !fieldStr.includes(expectedStr);
      case 'starts_with':
        return fieldStr.startsWith(expectedStr);
      case 'ends_with':
        return fieldStr.endsWith(expectedStr);
      case 'greater_than':
        return Number(fieldValue) > Number(expectedValue);
      case 'less_than':
        return Number(fieldValue) < Number(expectedValue);
      case 'is_empty':
        return !fieldValue || String(fieldValue).trim() === '';
      case 'is_not_empty':
        return fieldValue && String(fieldValue).trim() !== '';
      default:
        this.logger.warn('Unknown operator', { operator });
        return false;
    }
  }

  /**
   * Selective interpolation for conditional nodes
   * Only interpolates expected values, preserves field names in {{}} format
   */
  private async selectiveInterpolateNodeData(input: any, nodeData: any): Promise<any> {
    if (!nodeData || !nodeData.paths) {
      return nodeData;
    }

    // Clone the node data to avoid modifying the original
    const clonedData = JSON.parse(JSON.stringify(nodeData));
    
    // Process each path
    if (Array.isArray(clonedData.paths)) {
      for (const path of clonedData.paths) {
        if (path.conditions && Array.isArray(path.conditions)) {
          for (const condition of path.conditions) {
            // Preserve the field name as-is (don't interpolate it)
            // Only interpolate the expected value
            if (condition.value !== undefined) {
              condition.value = await this.interpolateValue(condition.value, input);
            }
          }
        }
      }
    }

    return clonedData;
  }

  /**
   * Interpolates a single value using the base class interpolation
   */
  private async interpolateValue(value: any, input: any): Promise<any> {
    if (typeof value !== 'string' || !value.includes('{{')) {
      return value; // No interpolation needed
    }
    
    // Create a temporary object to use base class interpolation
    const tempData = { tempValue: value };
    const interpolated = await this.interpolateNodeData(input, tempData);
    return interpolated.tempValue;
  }

  /**
   * Load contact data from the CRM. Returns the in-memory `HydratedContact`
   * shape (camelCase) so existing condition field names (`email`,
   * `phoneNumber`, `customAttributes.X`) keep working.
   */
  private async loadContactData(
    contactId: string,
  ): Promise<any> {
    try {
      const { CrmClientService } = await import(
        '../../../../shared/crm-client/crm-client.service'
      );
      const { ContactsClientService } = await import(
        '../../../../shared/crm-client/contacts-client.service'
      );
      const { mapContactDto } = await import(
        '../../../../shared/crm-client/types/contact'
      );

      const client = new ContactsClientService(new CrmClientService());
      const dto = await client.findById(contactId);
      return mapContactDto(dto) || {};
    } catch (error: any) {
      this.logger.warn('Failed to load contact data', {
        contactId,
        error: error.message,
      });
      return {};
    }
  }

  /**
   * Load session variables
   */
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
      this.logger.warn('Failed to load session variables', {
        sessionId,
        error: error.message,
      });
      return {};
    }
  }
}
