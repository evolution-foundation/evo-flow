import { BaseNode, NodeExecutionResult } from './base.node';
import axios, { AxiosRequestConfig } from 'axios';

export interface SendWebhookNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    webhookUrl: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    body?: string;
    bodyType?: 'json' | 'form' | 'text' | 'xml';
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
          if (body && method !== 'GET') {
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
        extractedVariables: Object.keys(extractedVariables),
      };
    })
      .then(({ result, executionTime }) => {
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_webhook_status`]: result.webhookStatus,
          [`node_${input.nodeId}_response_size`]: JSON.stringify(
            result.responseData || {},
          ).length,
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
   * Extract variable name from {{variableName}} format
   */
  private extractVariableName(variableExpression: string): string | null {
    const match = variableExpression.match(/\{\{([^}]+)\}\}/);
    return match ? match[1].trim() : null;
  }
}
