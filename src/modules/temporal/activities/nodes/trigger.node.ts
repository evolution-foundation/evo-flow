import { BaseNode, NodeExecutionResult } from './base.node';

export interface VariableMapping {
  id: string;
  sourcePath: string;
  variableName: string;
  transform?: 'none' | 'uppercase' | 'lowercase' | 'date' | 'number';
}

export interface TriggerNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  triggerEvent?: {
    messageId: string;
    eventName: string;
    eventType: string;
    properties: Record<string, any>;
    // identify-DTO payload (custom attribute, label) rides in traits (EVO-1839).
    traits?: Record<string, any>;
    timestamp: string;
  };
  nodeData: {
    label: string;
    triggerType: string;
    eventName?: string;
    webhookUrl?: string;
    variableMappings?: VariableMapping[];
    nextNodeId?: string;
  };
}

export class TriggerNode extends BaseNode {
  constructor() {
    super('Trigger');
  }

  async execute(input: TriggerNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      const { variableMappings = [], triggerType } = input.nodeData;
      const { triggerEvent } = input;

      // Parse trigger event properties if they come as JSON string
      if (triggerEvent && typeof triggerEvent.properties === 'string') {
        try {
          triggerEvent.properties = JSON.parse(triggerEvent.properties);
        } catch (error) {
          this.logger.warn('Failed to parse trigger event properties', {
            nodeId: input.nodeId,
            properties: triggerEvent.properties,
            error: error.message,
          });
        }
      }

      // Process variable mappings from trigger data
      const mappedVariables: Record<string, any> = {};

      if (variableMappings.length > 0 && triggerEvent) {
        for (const mapping of variableMappings) {
          try {
            // Extract value from trigger event based on source path
            const sourceValue = this.extractValueFromPath(
              triggerEvent,
              mapping.sourcePath,
            );

            if (sourceValue !== undefined) {
              // Apply transformation
              const transformedValue = this.applyTransform(
                sourceValue,
                mapping.transform,
              );

              // Extract variable name from {{variableName}} format
              const variableName = this.extractVariableName(
                mapping.variableName,
              );

              if (variableName) {
                // Remove journey_ prefix, just use the variable name directly
                mappedVariables[variableName] = transformedValue;

                this.logger.log('Variable mapped from trigger', {
                  nodeId: input.nodeId,
                  sourcePath: mapping.sourcePath,
                  variableName,
                  sourceValue,
                  transformedValue,
                  transform: mapping.transform,
                });
              }
            }
          } catch (error: any) {
            this.logger.warn('Failed to map variable from trigger', {
              nodeId: input.nodeId,
              mappingId: mapping.id,
              sourcePath: mapping.sourcePath,
              variableName: mapping.variableName,
              error: error.message,
            });
          }
        }
      }

      // Add trigger execution metadata
      const triggerVariables = {
        [`trigger_${input.nodeId}_executed`]: true,
        [`trigger_${input.nodeId}_timestamp`]: new Date().toISOString(),
        [`trigger_${input.nodeId}_type`]: triggerType,
        ...mappedVariables,
      };

      // Add event data to variables if present
      if (triggerEvent) {
        triggerVariables[`trigger_event_name`] = triggerEvent.eventName;
        triggerVariables[`trigger_event_type`] = triggerEvent.eventType;
        triggerVariables[`event_name`] = triggerEvent.eventName;
        triggerVariables[`event_value`] = triggerEvent.properties?.value;

        // Add event properties as flattened variables
        if (triggerEvent.properties) {
          for (const [key, value] of Object.entries(triggerEvent.properties)) {
            triggerVariables[`event_${key}`] = value;
          }
        }
        // NOTE: traits flattening intentionally lives only in the `.then()` block
        // below — that is the block whose variables are actually returned via
        // createSuccessResult. This `triggerVariables` object is not returned, so
        // mirroring traits here would be dead code (EVO-1839 review F2).
      }

      this.logger.log('Trigger node completed', {
        nodeId: input.nodeId,
        triggerType,
        mappedVariablesCount: Object.keys(mappedVariables).length,
        totalVariables: Object.keys(triggerVariables).length,
      });

      return {
        triggerType,
        mappedVariables,
        eventProcessed: !!triggerEvent,
        triggerEvent,
      };
    })
      .then(({ result, executionTime }) => {
        // Merge trigger metadata with mapped variables
        const allVariables = {
          [`trigger_${input.nodeId}_executed`]: true,
          [`trigger_${input.nodeId}_timestamp`]: new Date().toISOString(),
          [`trigger_${input.nodeId}_type`]: result.triggerType,
          ...result.mappedVariables, // Use the actual mapped variables
        };

        // Add event data to variables if present
        if (result.triggerEvent) {
          allVariables[`trigger_event_name`] = result.triggerEvent.eventName;
          allVariables[`trigger_event_type`] = result.triggerEvent.eventType;
          allVariables[`event_name`] = result.triggerEvent.eventName;
          allVariables[`event_value`] =
            result.triggerEvent.properties?.value ??
            result.triggerEvent.traits?.value;

          // Add event properties as flattened variables
          if (result.triggerEvent.properties) {
            for (const [key, value] of Object.entries(
              result.triggerEvent.properties,
            )) {
              allVariables[`event_${key}`] = value;
            }
          }
          // identify-DTO payloads ride in traits — flatten them too, without
          // clobbering any property of the same name (EVO-1839).
          if (result.triggerEvent.traits) {
            for (const [key, value] of Object.entries(
              result.triggerEvent.traits,
            )) {
              if (allVariables[`event_${key}`] === undefined) {
                allVariables[`event_${key}`] = value;
              }
            }
          }
        }

        return this.createSuccessResult(input, executionTime, allVariables);
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  /**
   * Extract value from object using dot notation path
   */
  private extractValueFromPath(data: any, path: string): any {
    if (!path) return undefined;

    // Handle paths like "webhook.body.contact_id" or "event.properties.message_type"
    const parts = path.split('.');
    let current = data;

    // Handle webhook paths - map to trigger event data
    if (parts[0] === 'webhook' && parts[1] === 'body') {
      // webhook.body.* maps to triggerEvent.properties.*
      const propertyPath = parts.slice(2);
      current = data.properties || {};

      for (const part of propertyPath) {
        if (current && typeof current === 'object' && part in current) {
          current = current[part];
        } else {
          return undefined;
        }
      }
      return current;
    }

    // Handle custom-attribute mappings. The FE (CustomAttributeConfiguration)
    // persists `attribute.*` sourcePaths, but `contact.custom_attribute.changed`
    // is an identify DTO whose payload rides in `traits`
    // (attributeName/attributeValue/oldValue) — resolve them explicitly so the
    // VariableMapping actually populates (EVO-1839 AC2).
    if (parts[0] === 'attribute') {
      const traits = data.traits || {};
      const properties = data.properties || {};
      const key = parts.slice(1).join('.');

      switch (key) {
        case 'name':
          return traits.attributeName ?? properties.attributeName;
        case 'value':
          return traits.attributeValue ?? properties.attributeValue;
        case 'previous_value':
          return traits.oldValue ?? properties.oldValue;
        case 'timestamp':
          return data.timestamp;
      }

      // Attribute-specific paths: `attribute.<name>` / `attribute.<name>_previous`
      // (the FE emits the selected attribute key verbatim). Only resolve when the
      // event is for that attribute.
      const eventAttrName = traits.attributeName ?? properties.attributeName;
      if (eventAttrName !== undefined) {
        if (key === `${eventAttrName}_previous`) {
          return traits.oldValue ?? properties.oldValue;
        }
        if (key === eventAttrName) {
          return traits.attributeValue ?? properties.attributeValue;
        }
      }

      return undefined;
    }

    // Handle event paths directly
    if (parts[0] === 'event') {
      const eventPath = parts.slice(1);

      // identify-DTO payloads (custom attribute, label) ride in `traits`, but the
      // FE persists `event.properties.<key>` paths — try properties, fall back to
      // traits so those mappings populate (EVO-1839).
      if (eventPath[0] === 'properties') {
        const key = eventPath.slice(1);
        const fromProps = this.walkPath(data.properties, key);
        return fromProps !== undefined
          ? fromProps
          : this.walkPath(data.traits, key);
      }

      // Generic event.* walk (also resolves `event.traits.<key>`).
      return this.walkPath(current, eventPath);
    }

    // Default path resolution
    return this.walkPath(current, parts);
  }

  /**
   * Walk an object by a dot-path key array, returning undefined on any miss.
   * Preserves the object guard so array/primitive traversal is unchanged.
   */
  private walkPath(obj: any, parts: string[]): any {
    let current = obj;
    for (const part of parts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    return current;
  }

  /**
   * Apply transformation to value
   */
  private applyTransform(value: any, transform?: string): any {
    if (!transform || transform === 'none') {
      return value;
    }

    const stringValue = String(value);

    switch (transform) {
      case 'uppercase':
        return stringValue.toUpperCase();
      case 'lowercase':
        return stringValue.toLowerCase();
      case 'number':
        const num = Number(value);
        return isNaN(num) ? value : num;
      case 'date':
        try {
          const date = new Date(value);
          return isNaN(date.getTime()) ? value : date.toISOString();
        } catch {
          return value;
        }
      default:
        return value;
    }
  }

  /**
   * Extract variable name from {{variableName}} format
   */
  private extractVariableName(variableExpression: string): string | null {
    const match = variableExpression.match(/\{\{([^}]+)\}\}/);
    return match ? match[1].trim() : null;
  }
}
