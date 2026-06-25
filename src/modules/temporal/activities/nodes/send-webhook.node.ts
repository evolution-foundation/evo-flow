import { BaseNode, NodeExecutionResult } from './base.node';
import axios, { AxiosRequestConfig } from 'axios';

export interface SendWebhookNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  // EVO-1882: needed by interpolateNodeData to resolve journey-level variable
  // defaults; the workflow must supply it at dispatch.
  journeyId?: string;
  nodeData: {
    webhookUrl: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    body?: string;
    bodyType?: 'json' | 'form' | 'text' | 'xml';
    // EVO-1858: structured key/value body builder (EVO-1742 editor model). When
    // bodyMode is structured (or absent with rows present), the executor builds the
    // request body from these typed rows instead of JSON.parse-ing the serialized
    // `body` string — so number/boolean rows ship as real JSON primitives.
    bodyStructured?: Array<{
      id: string;
      key: string;
      value: string;
      type: 'string' | 'number' | 'boolean';
    }>;
    bodyMode?: 'structured' | 'raw';
    headers?: Array<{ key: string; value: string }>;
    timeout?: number;
    retryAttempts?: number;
    authenticationType?: 'none' | 'bearer' | 'basic' | 'api_key';
    authToken?: string;
    authUsername?: string;
    authPassword?: string;
    authApiKey?: string;
    authApiKeyHeader?: string;
    responseMappings?: Array<{
      id: string;
      jsonPath: string;
      variableName: string;
      description?: string;
    }>;
    nextNodeId?: string;
  };
}

export class SendWebhookNode extends BaseNode {
  constructor() {
    super('SendWebhook');
  }

  async execute(input: SendWebhookNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      const {
        webhookUrl,
        method = 'POST',
        body,
        bodyType = 'json',
        bodyStructured,
        bodyMode,
        headers = [],
        timeout = 30,
        retryAttempts = 0,
        authenticationType = 'none',
        authToken,
        authUsername,
        authPassword,
        authApiKey,
        authApiKeyHeader = 'X-API-Key',
        responseMappings = [],
      } = interpolatedNodeData;

      if (!webhookUrl) {
        throw new Error('Webhook URL is required');
      }

      let attempts = 0;
      let lastError: Error | null = null;
      let webhookResponse: any = null;

      while (attempts <= retryAttempts) {
        try {
          // Prepare request config
          const config: AxiosRequestConfig = {
            method: method.toLowerCase() as any,
            url: webhookUrl,
            timeout: timeout * 1000,
            headers: {
              'User-Agent': 'EvoAI-Campaign-Worker/1.0',
            },
          };

          // Add custom headers
          if (headers.length > 0) {
            for (const header of headers) {
              if (header.key && header.value) {
                config.headers![header.key] = header.value;
              }
            }
          }

          // Add authentication
          if (authenticationType === 'bearer' && authToken) {
            config.headers!['Authorization'] = `Bearer ${authToken}`;
          } else if (
            authenticationType === 'basic' &&
            authUsername &&
            authPassword
          ) {
            const credentials = Buffer.from(
              `${authUsername}:${authPassword}`,
            ).toString('base64');
            config.headers!['Authorization'] = `Basic ${credentials}`;
          } else if (authenticationType === 'basic' && authToken) {
            // Fallback for pre-encoded basic auth
            config.headers!['Authorization'] = `Basic ${authToken}`;
          } else if (authenticationType === 'api_key' && authApiKey) {
            config.headers![authApiKeyHeader] = authApiKey;
          }

          // Add body for non-GET requests
          if (method !== 'GET') {
            // EVO-1858: prefer the structured rows when present. Gate on
            // `bodyMode !== 'raw'` (NOT `=== 'structured'`): the frontend only
            // persists bodyMode on an explicit structured⇄raw toggle, so a
            // normally-built node has rows but an undefined bodyMode. Requiring
            // 'structured' would route every such node back to JSON.parse(body)
            // and silently drop the typing. Mirrors getEffectiveBodyMode.
            const useStructured =
              bodyMode !== 'raw' &&
              Array.isArray(bodyStructured) &&
              bodyStructured.length > 0 &&
              (bodyType === 'json' || bodyType === 'form');

            if (useStructured) {
              if (bodyType === 'json') {
                config.headers!['Content-Type'] = 'application/json';
                config.data = this.buildStructuredJson(bodyStructured!);
              } else {
                config.headers!['Content-Type'] =
                  'application/x-www-form-urlencoded';
                config.data = this.buildStructuredForm(bodyStructured!);
              }
            } else if (body) {
              // Unchanged legacy / raw-mode path (back-compat).
              if (bodyType === 'json') {
                config.headers!['Content-Type'] = 'application/json';
                config.data = JSON.parse(body);
              } else if (bodyType === 'form') {
                config.headers!['Content-Type'] =
                  'application/x-www-form-urlencoded';
                config.data = body;
              } else if (bodyType === 'xml') {
                config.headers!['Content-Type'] = 'application/xml';
                config.data = body;
              } else {
                config.headers!['Content-Type'] = 'text/plain';
                config.data = body;
              }
            }
          }

          this.logger.log('Sending webhook request', {
            nodeId: input.nodeId,
            method,
            url: webhookUrl,
            attempt: attempts + 1,
            maxAttempts: retryAttempts + 1,
          });

          // Send webhook request
          const response = await axios(config);
          webhookResponse = response.data;

          this.logger.log('Webhook request successful', {
            nodeId: input.nodeId,
            status: response.status,
            responseSize: JSON.stringify(webhookResponse).length,
          });

          break; // Success, exit retry loop
        } catch (error: any) {
          attempts++;
          lastError = error;

          this.logger.warn('Webhook request failed', {
            nodeId: input.nodeId,
            attempt: attempts,
            maxAttempts: retryAttempts + 1,
            error: error.message,
            status: error.response?.status,
          });

          if (attempts > retryAttempts) {
            throw new Error(
              `Webhook failed after ${attempts} attempts: ${error.message}`,
            );
          }

          // Wait before retry (exponential backoff)
          const waitTime = Math.min(1000 * Math.pow(2, attempts - 1), 10000);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }

      // Process response mappings to extract variables
      const extractedVariables: Record<string, any> = {};

      if (responseMappings.length > 0 && webhookResponse) {
        for (const mapping of responseMappings) {
          try {
            const value = this.extractValueFromResponse(
              webhookResponse,
              mapping.jsonPath,
            );

            if (value !== undefined) {
              // Extract variable name from {{variableName}} format
              const variableName = this.extractVariableName(
                mapping.variableName,
              );
              if (variableName) {
                extractedVariables[`journey_${variableName}`] = value;
              }
            }
          } catch (error: any) {
            this.logger.warn(
              'Failed to extract variable from webhook response',
              {
                nodeId: input.nodeId,
                jsonPath: mapping.jsonPath,
                variableName: mapping.variableName,
                error: error.message,
              },
            );
          }
        }
      }

      this.logger.log('Webhook node completed', {
        nodeId: input.nodeId,
        extractedVariablesCount: Object.keys(extractedVariables).length,
        responseStatus: 'success',
      });

      return {
        webhookStatus: 'success',
        responseData: webhookResponse,
        // EVO-1916: carry the FULL key→value map (journey_<name> → value), not
        // just Object.keys(...). The success branch below spreads this into the
        // session variables; spreading an array of names there produced
        // index-keyed junk ({0:'journey_x'}) and dropped every extracted value,
        // so {{journey_<name>}} never resolved in downstream nodes (D6).
        extractedVariables,
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_webhook_status`]: result.webhookStatus,
          [`node_${input.nodeId}_response_size`]: JSON.stringify(
            result.responseData || {},
          ).length,
          // Persist the extracted journey_<name> variables onto the session.
          ...result.extractedVariables,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  /**
   * Extract value from response using JSONPath-like syntax
   */
  private extractValueFromResponse(response: any, jsonPath: string): any {
    if (!jsonPath || jsonPath === 'response') {
      return response;
    }

    // Simple JSONPath implementation
    const parts = jsonPath.split('.');
    let current = response;

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
   * Resolve the bare variable name from a response-mapping `variableName`.
   *
   * EVO-1916: the editor stores the mapping target as a plain identifier
   * (e.g. `echoed_qty`), but some authoring paths wrap it as `{{echoed_qty}}`.
   * Accept both: unwrap the `{{ }}` when present, otherwise use the trimmed
   * literal. Returning null only for a genuinely empty name means a typical
   * mapping no longer silently drops its extracted value.
   */
  private extractVariableName(
    variableExpression: string | null | undefined,
  ): string | null {
    if (!variableExpression) {
      return null;
    }
    const match = variableExpression.match(/\{\{([^}]+)\}\}/);
    const name = match ? match[1].trim() : variableExpression.trim();
    return name.length > 0 ? name : null;
  }

  /**
   * Build the JSON request body from structured rows (EVO-1858).
   *
   * Rows arrive already interpolated (interpolateNodeData recurses into the
   * array), so coercion runs AFTER substitution. Blank-key rows are skipped to
   * mirror the frontend `fieldsWithKey`. Returns an object — axios serializes it,
   * matching the shape the legacy `JSON.parse(body)` path produced.
   */
  private buildStructuredJson(
    fields: NonNullable<SendWebhookNodeInput['nodeData']['bodyStructured']>,
  ): Record<string, string | number | boolean> {
    const obj: Record<string, string | number | boolean> = {};
    for (const f of fields) {
      if (!f.key || f.key.trim() === '') continue;
      obj[f.key] = this.coerceJsonValue(f.value ?? '', f.type);
    }
    return obj;
  }

  /**
   * Build the form request body from structured rows (EVO-1858).
   *
   * Mirrors the frontend `serializeBody` form path: `key=value&...` with NO
   * percent-encoding (so `{{variables}}` survive) and NO type coercion (form
   * values are always strings). Blank-key rows are skipped.
   */
  private buildStructuredForm(
    fields: NonNullable<SendWebhookNodeInput['nodeData']['bodyStructured']>,
  ): string {
    return fields
      .filter((f) => f.key && f.key.trim() !== '')
      .map((f) => `${f.key}=${f.value ?? ''}`)
      .join('&');
  }

  /**
   * Coerce a structured row value to the JS primitive its `type` declares
   * (EVO-1858). Mirror of the frontend `coerceJsonValue` (EVO-1742
   * webhookBody.ts), run AFTER interpolation: a value still carrying a `{{token}}`
   * (variable that failed to resolve) or a non-finite numeric literal stays a
   * string rather than emitting `NaN`.
   */
  private coerceJsonValue(
    value: string,
    type: 'string' | 'number' | 'boolean',
  ): string | number | boolean {
    if (typeof value === 'string' && value.includes('{{')) return value;
    if (type === 'number') {
      const trimmed = String(value).trim();
      if (trimmed !== '' && Number.isFinite(Number(trimmed))) {
        return Number(trimmed);
      }
      return value;
    }
    if (type === 'boolean') {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    }
    return value;
  }
}
