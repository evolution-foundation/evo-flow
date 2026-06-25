import { BaseNode, NodeExecutionResult } from './base.node';

const CONVERSATION_FIELD_PATTERN = /\{\{conversation\.([^}]+)\}\}/;
const CONTACT_FIELD_PATTERN = /\{\{contact\.([^}]+)\}\}/;

// Picker-facing contact field names that differ from the loaded
// `HydratedContact` shape. The field picker offers `{{contact.phone}}`, but the
// hydrated contact exposes `phoneNumber` — map the leading segment so the
// offered field actually resolves. Only the head segment is aliased, so nested
// paths like `customAttributes.<key>` are untouched.
const CONTACT_FIELD_ALIASES: Record<string, string> = {
  phone: 'phoneNumber',
};

export interface ConditionalNodeInput {
  nodeId: string;
  contactId: string;
  conversationId?: string;
  sessionId: string;
  journeyId?: string; // EVO-1917: resolve journey-default {{variables}} in condition values via interpolateNodeData
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

      // Load contact data only when a condition actually needs the contact —
      // either a {{contact.*}} field (resolved by field pattern regardless of
      // type, mirroring evaluateCondition) or a `type: 'contact'` condition.
      // Avoids a CRM round-trip on Conditional nodes that only read session
      // variables. Empty object when out of scope: resolveContactField then
      // returns undefined for every field, the correct "no match" signal.
      const needsContactData = paths.some((path) =>
        (path.conditions || []).some(
          (condition) =>
            condition?.type === 'contact' ||
            (typeof condition?.field === 'string' &&
              CONTACT_FIELD_PATTERN.test(condition.field)),
        ),
      );
      const contactData = needsContactData
        ? await this.loadContactData(input.contactId)
        : {};

      // Load conversation data only when a path actually references a
      // {{conversation.*}} field — avoids a CRM round-trip on every Conditional
      // node that does not need it. Null when out of scope or unavailable.
      const needsConversationData = paths.some((path) =>
        (path.conditions || []).some(
          (condition) =>
            typeof condition.field === 'string' &&
            CONVERSATION_FIELD_PATTERN.test(condition.field),
        ),
      );
      const conversationData = needsConversationData
        ? await this.loadConversationData(input.conversationId)
        : null;

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
          conversationData,
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
    conversationData: any,
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
        conversationData,
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
    conversationData: any,
    sessionVariables: Record<string, any>,
    input: ConditionalNodeInput,
  ): Promise<boolean> {
    const { type, field, operator, value } = condition;

    // Conversation fields ({{conversation.*}}) are resolved against the live
    // conversation regardless of the condition `type`, since the field is
    // selected as a system variable rather than tied to a dedicated type.
    if (typeof field === 'string' && CONVERSATION_FIELD_PATTERN.test(field)) {
      const stageIds = this.resolveConversationField(field, conversationData);
      return this.compareConversationStage(stageIds, operator, value);
    }

    // Contact fields ({{contact.*}}, including customAttributes.*) resolve
    // against the loaded contact regardless of the condition `type` — the
    // field can be selected from the shared field picker on any condition
    // type (mirrors the conversation case above).
    if (typeof field === 'string' && CONTACT_FIELD_PATTERN.test(field)) {
      const fieldValue = this.resolveContactField(field, contactData);
      return this.compareValues(fieldValue, operator, value);
    }

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
   * Resolve contact field value. Supports nested dot paths so
   * `{{contact.customAttributes.<attribute_key>}}` reads from the loaded
   * contact's `customAttributes` map (single-level fields like `email` /
   * `name` / `identifier` keep resolving unchanged). The leading segment is
   * run through CONTACT_FIELD_ALIASES so picker names that differ from the
   * hydrated shape (e.g. `phone` → `phoneNumber`) resolve correctly.
   */
  private resolveContactField(field: string, contactData: any): any {
    // Handle {{contact.field}} / {{contact.customAttributes.key}} format
    const match = field.match(CONTACT_FIELD_PATTERN);
    const rawPath = match ? match[1] : field;

    const [head, ...rest] = rawPath.split('.');
    const path = [CONTACT_FIELD_ALIASES[head] ?? head, ...rest].join('.');

    return this.resolveNestedPath(contactData, path);
  }

  /**
   * Walk a dot-delimited path against an object (e.g.
   * "customAttributes.plan_interest"). Returns undefined if any segment is
   * missing. NOTE: unlike set-variable.node.ts (which preserves the literal
   * {{token}} on a miss), this returns undefined — the correct "no match"
   * signal for compareValues' null short-circuit.
   */
  private resolveNestedPath(obj: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (acc, part) =>
          acc != null && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[part]
            : undefined,
        obj,
      );
  }

  /**
   * Resolve a {{conversation.*}} field against the live conversation payload.
   *
   * Currently supports `pipeline_stage_id`: returns the ids of the conversation's
   * current pipeline stage(s). A conversation can sit in more than one pipeline
   * (`pipeline_items` is has_many), so this returns every current stage id —
   * membership is decided by `compareConversationStage`. Returns an empty array
   * when there is no conversation or no pipeline item (null-safety).
   */
  private resolveConversationField(
    field: string,
    conversationData: any,
  ): string[] {
    const match = field.match(CONVERSATION_FIELD_PATTERN);
    const fieldName = match?.[1];

    if (fieldName === 'pipeline_stage_id') {
      const pipelines = conversationData?.pipelines;
      if (!Array.isArray(pipelines)) return [];

      return pipelines
        .flatMap((pipeline: any) =>
          Array.isArray(pipeline?.stages) ? pipeline.stages : [],
        )
        .map((stage: any) => stage?.id)
        .filter((id: any): id is string => typeof id === 'string');
    }

    this.logger.warn('Unsupported conversation field', { field });
    return [];
  }

  /**
   * Compare the conversation's current stage id(s) against the selected stage.
   * When the conversation has no stage (empty array), every operator resolves
   * to false so an unknown/absent stage never matches and never crashes.
   */
  private compareConversationStage(
    stageIds: string[],
    operator: string,
    expectedValue: any,
  ): boolean {
    // No target stage selected or no current stage → never match (conservative).
    if (!expectedValue || !stageIds.length) return false;

    const expected = String(expectedValue);
    switch (operator) {
      case 'equals':
        return stageIds.includes(expected);
      case 'not_equals':
        return !stageIds.includes(expected);
      default:
        this.logger.warn('Unsupported operator for conversation stage', {
          operator,
        });
        return false;
    }
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
    // Handle null/undefined values. A missing value IS empty, so the
    // emptiness operators must answer from that fact rather than falling
    // through to the generic "no match" (which would wrongly report a
    // missing contact custom attribute as non-empty).
    if (fieldValue == null) {
      switch (operator) {
        case 'is_empty':
          return true;
        case 'is_not_empty':
          return false;
        case 'not_equals':
          return expectedValue != null;
        default:
          return false;
      }
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
      // A successful fetch may legitimately carry no attributes — that empty
      // mapping is a valid "no match" signal and must NOT be treated as failure.
      return mapContactDto(dto) || {};
    } catch (error: any) {
      // EVO-1913: a CRM/hydration failure is NOT the same as "contact has no
      // such attribute". Swallowing it as `{}` made every contact-attribute
      // condition evaluate false → silent route to ELSE with no error. Surface
      // it instead: log ERROR and re-throw so the node fails visibly (the
      // executor records node_failed + telemetry) rather than mis-routing.
      this.logger.error('Failed to load contact data for condition evaluation', {
        contactId,
        error: error.message,
      });
      throw new Error(`Failed to load contact data: ${error.message}`);
    }
  }

  /**
   * Load conversation data from the CRM for evaluating {{conversation.*}}
   * fields. Returns null when there is no conversation in scope (e.g. a
   * contact-triggered journey) or when the request fails, so callers degrade
   * to a non-matching condition instead of crashing.
   */
  private async loadConversationData(conversationId?: string): Promise<any> {
    if (!conversationId) return null;

    try {
      const { CrmClientService } = await import(
        '../../../../shared/crm-client/crm-client.service'
      );

      const client = new CrmClientService();
      const response = await client.getConversation({ conversationId });
      // conversations#show returns a success_response envelope ({ success, data, meta })
      // and executeRequest stores the raw body as `data`, so the conversation
      // (with pipelines) sits one level deeper at response.data.data.
      return response?.data?.data ?? null;
    } catch (error: any) {
      // EVO-1913: a request failure here is not a benign "no conversation in
      // scope" (that case returns early above with no error). Make the failure
      // visible at ERROR level; we still degrade to null so a contact-triggered
      // journey keeps evaluating, but the cause is no longer invisible.
      this.logger.error('Failed to load conversation data', {
        conversationId,
        error: error.message,
      });
      return null;
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
      // EVO-1913: surface the failure at ERROR level instead of swallowing it
      // as an empty bag silently (which made {{session var}} conditions all
      // evaluate false with no trace). Degrade to {} so evaluation continues,
      // but the cause is now visible in the logs.
      this.logger.error('Failed to load session variables', {
        sessionId,
        error: error.message,
      });
      return {};
    }
  }
}
