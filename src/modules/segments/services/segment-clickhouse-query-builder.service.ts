import { Injectable } from '@nestjs/common';
import { Segment } from '../entities/segment.entity';
import {
  SegmentNode,
  SegmentNodeType,
  AndSegmentNode,
  OrSegmentNode,
} from '../entities/segment.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface StateSubQuery {
  stateId: string;
  condition: string;
  argMaxValue?: string;
  uniqValue?: string;
  eventTimeExpression?: string;
  recordMessageId: boolean;
  joinPriorStateValue: boolean;
  type: 'segment' | 'contact_property';
  computedPropertyId: string;
  useCountQuery?: boolean;
  timesOperator?: string;
  expectedTimes?: number;
  validationInfo?: {
    operator: string;
    value: string;
    extractPath: string;
  };
}

@Injectable()
export class SegmentClickHouseQueryBuilderService {
  private readonly logger = new CustomLoggerService(
    SegmentClickHouseQueryBuilderService.name,
  );

  /**
   * Convert segment nodes to state sub-queries using modular builders
   */
  segmentNodeToStateSubQuery(
    segment: Segment,
    node: SegmentNode,
    definition?: any,
  ): StateSubQuery[] {
    const stateId = this.generateStateId(segment, node.id);

    switch (node.type) {
      case SegmentNodeType.Email: {
        return [
          {
            stateId,
            condition: `JSONExtractString(traits, 'email') != ''`,
            argMaxValue: `JSONExtractString(traits, 'email')`,
            uniqValue: `message_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: true,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
          },
        ];
      }

      case SegmentNodeType.UserProperty: {
        const userPropNode = node as any;
        if (!userPropNode.path) {
          this.logger.warn(`UserProperty node ${userPropNode.id} missing path`);
          return [];
        }

        // Definir campos mutáveis que devem usar argMax para consistência temporal
        const mutableFields = [
          'email',
          'name',
          'phoneNumber',
          'identifier',
          'middleName',
          'lastName',
          'location',
          'countryCode',
          'contactType',
          'blocked',
          'budget',
          'industry',
          'employees',
          'city',
          'source',
          'leadScore',
          'companyName',
        ];

        // Construir condição baseada no operador e path
        let condition = '';
        let extractPath = '';
        let argMaxValue = '';
        let useArgMax = false;
        let operator = '';
        let value = '';

        // Determinar como extrair o valor baseado no path
        if (userPropNode.path === 'labels') {
          // Labels agora são eventos separados (label_added/label_removed)
          // Este caso não deveria mais ser usado, mas manter para compatibilidade
          extractPath = 'labels';
          useArgMax = false; // Usar lógica simples
        } else if (userPropNode.path === 'customAttributes') {
          // Custom attributes precisa do key específico
          if (userPropNode.operator?.value) {
            extractPath = `customAttributes.${userPropNode.operator.value}`;
          } else {
            extractPath = 'customAttributes';
          }
          useArgMax = true; // Custom attributes podem mudar
        } else if (userPropNode.path.startsWith('customAttributes.')) {
          // Path completo de custom attribute - mas na verdade está salvo como campo direto
          const customAttributeName = userPropNode.path.replace(
            'customAttributes.',
            '',
          );
          extractPath = customAttributeName; // Campo direto, não aninhado
          useArgMax = true; // Custom attributes podem mudar
          this.logger.debug(
            `Custom attribute mapping: original path=${userPropNode.path}, extractPath=${extractPath}`,
          );
        } else if (userPropNode.path.startsWith('additionalAttributes.')) {
          // Additional attributes
          extractPath = userPropNode.path;
          useArgMax = true; // Additional attributes podem mudar
        } else {
          // Campos diretos como email, name, phone
          extractPath = userPropNode.path;
          useArgMax = mutableFields.includes(userPropNode.path);
        }

        // Aplicar operador
        if (userPropNode.operator) {
          operator =
            typeof userPropNode.operator === 'object'
              ? userPropNode.operator.type
              : userPropNode.operator;
          value =
            typeof userPropNode.operator === 'object'
              ? String(userPropNode.operator.value || '')
              : String(userPropNode.value || '');

          // Para labels (array) - comportamento simples sem argMax
          if (userPropNode.path === 'labels') {
            // Labels agora usam eventos separados, mas mantemos suporte legado
            switch (operator) {
              case 'Contains':
                condition = `has(JSONExtractArrayRaw(traits, 'labels'), '"${value}"')`;
                break;
              case 'NotContains':
                condition = `NOT has(JSONExtractArrayRaw(traits, 'labels'), '"${value}"')`;
                break;
              case 'Exists':
                condition = `JSONExtractArrayRaw(traits, 'labels') != '[]'`;
                break;
              case 'NotExists':
                condition = `JSONExtractArrayRaw(traits, 'labels') = '[]'`;
                break;
              default:
                condition = `has(JSONExtractArrayRaw(traits, 'labels'), '"${value}"')`;
            }
          } else {
            // Para campos string/número - para campos mutáveis, não usar argMax na condição WHERE
            // A condição inicial será sempre verdadeira e a validação será feita no argMaxValue
            if (useArgMax) {
              // Para campos mutáveis: condição sempre verdadeira, validação no argMaxValue
              condition = `JSONExtractString(traits, '${extractPath}') != ''`; // Sempre inclui se o campo existe
            } else {
              // Para campos imutáveis: aplicar condição diretamente
              const extractFunc = `JSONExtractString(traits, '${extractPath}')`;

              switch (operator) {
                case 'Equals':
                  condition = `${extractFunc} = '${value}'`;
                  break;
                case 'NotEquals':
                  condition = `${extractFunc} != '${value}'`;
                  break;
                case 'Contains':
                  condition = `${extractFunc} LIKE '%${value}%'`;
                  break;
                case 'NotContains':
                  condition = `${extractFunc} NOT LIKE '%${value}%'`;
                  break;
                case 'GreaterThan':
                  condition = `toFloat64OrNull(${extractFunc}) > ${value}`;
                  break;
                case 'GreaterThanOrEqual':
                  condition = `toFloat64OrNull(${extractFunc}) >= ${value}`;
                  break;
                case 'LessThan':
                  condition = `toFloat64OrNull(${extractFunc}) < ${value}`;
                  break;
                case 'LessThanOrEqual':
                  condition = `toFloat64OrNull(${extractFunc}) <= ${value}`;
                  break;
                case 'Exists':
                  condition = `${extractFunc} != ''`;
                  break;
                case 'NotExists':
                  condition = `${extractFunc} = ''`;
                  break;
                default:
                  condition = `${extractFunc} != ''`;
              }
            }
          }
        } else {
          // Sem operador, apenas verifica existência
          condition = `JSONExtractString(traits, '${extractPath}') != ''`;
        }

        // Definir argMaxValue baseado na estratégia
        if (useArgMax) {
          // Para campos que usam argMax (sem labels) - adicionar verificação de contatos deletados
          argMaxValue = `
            CASE
              WHEN contact_or_anonymous_id IN (
                SELECT DISTINCT contact_or_anonymous_id 
                FROM contact_events 
                WHERE event_name = 'contact_deleted'
                GROUP BY contact_or_anonymous_id
                HAVING argMax(occurred_at, occurred_at) > 0
              ) THEN ''
              ELSE JSONExtractString(traits, '${extractPath}')
            END
          `
            .replace(/\s+/g, ' ')
            .trim();
        } else {
          // Lógica normal sem argMax
          if (userPropNode.path === 'labels') {
            // Labels usam array extraction - adicionar verificação de contatos deletados
            argMaxValue = `
              CASE
                WHEN contact_or_anonymous_id IN (
                  SELECT DISTINCT contact_or_anonymous_id 
                  FROM contact_events 
                  WHERE event_name = 'contact_deleted'
                  GROUP BY contact_or_anonymous_id
                  HAVING argMax(occurred_at, occurred_at) > 0
                ) THEN ''
                ELSE toString(occurred_at)
              END
            `
              .replace(/\s+/g, ' ')
              .trim();
          } else {
            argMaxValue = `
              CASE
                WHEN contact_or_anonymous_id IN (
                  SELECT DISTINCT contact_or_anonymous_id 
                  FROM contact_events 
                  WHERE event_name = 'contact_deleted'
                  GROUP BY contact_or_anonymous_id
                  HAVING argMax(occurred_at, occurred_at) > 0
                ) THEN ''
                ELSE JSONExtractString(traits, '${userPropNode.path}')
              END
            `
              .replace(/\s+/g, ' ')
              .trim();
          }
        }

        // Para campos mutáveis, incluir informação do operador e valor para validação posterior
        const validationInfo = useArgMax
          ? {
              operator,
              value,
              extractPath,
            }
          : undefined;

        return [
          {
            stateId,
            condition,
            argMaxValue,
            uniqValue: `message_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: true,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
            validationInfo, // Incluir informação de validação para campos mutáveis
          },
        ];
      }

      case SegmentNodeType.Performed: {
        const performedNode = node as any;
        if (!performedNode.event) {
          this.logger.warn(`Performed node ${node.id} missing event`);
          return [];
        }

        let condition = `event_name = '${performedNode.event}'`;

        // Adicionar condições de propriedades se houver
        if (performedNode.properties && performedNode.properties.length > 0) {
          const propertyConditions = performedNode.properties.map(
            (prop: any) => {
              const value = prop.operator?.value || '';
              const operator = prop.operator?.type || 'Equals';

              switch (operator) {
                case 'Equals':
                  return `JSONExtractString(properties, '${prop.path}') = '${value}'`;
                case 'NotEquals':
                  return `JSONExtractString(properties, '${prop.path}') != '${value}'`;
                case 'Contains':
                  return `JSONExtractString(properties, '${prop.path}') LIKE '%${value}%'`;
                case 'NotContains':
                  return `JSONExtractString(properties, '${prop.path}') NOT LIKE '%${value}%'`;
                case 'GreaterThan':
                  return `toFloat64OrNull(JSONExtractString(properties, '${prop.path}')) > ${value}`;
                case 'GreaterThanOrEqual':
                  return `toFloat64OrNull(JSONExtractString(properties, '${prop.path}')) >= ${value}`;
                case 'LessThan':
                  return `toFloat64OrNull(JSONExtractString(properties, '${prop.path}')) < ${value}`;
                case 'LessThanOrEqual':
                  return `toFloat64OrNull(JSONExtractString(properties, '${prop.path}')) <= ${value}`;
                case 'Exists':
                  return `JSONExtractString(properties, '${prop.path}') != ''`;
                case 'NotExists':
                  return `JSONExtractString(properties, '${prop.path}') = ''`;
                default:
                  return `JSONExtractString(properties, '${prop.path}') = '${value}'`;
              }
            },
          );

          condition += ` AND (${propertyConditions.join(' AND ')})`;
        }

        // Adicionar janela de tempo se especificada
        if (performedNode.withinSeconds) {
          condition += ` AND occurred_at >= now() - INTERVAL ${performedNode.withinSeconds} SECOND`;
        }

        // Para times e timesOperator, precisamos usar uma abordagem diferente para contar
        const useCountAggregation =
          performedNode.times !== undefined && performedNode.timesOperator;

        if (useCountAggregation) {
          // Para contagem, usamos uma sub-consulta que conta as ocorrências primeiro
          // e depois usa o resultado como valor argMax
          return [
            {
              stateId,
              condition,
              argMaxValue: `toString(1)`, // Usamos 1 como valor constante para cada registro
              uniqValue: `message_id`, // Cada evento é único por message_id
              eventTimeExpression: `occurred_at`,
              recordMessageId: true,
              joinPriorStateValue: false,
              type: 'segment',
              computedPropertyId: segment.id,
              useCountQuery: true, // Flag para indicar que precisamos de contagem especial
              timesOperator: performedNode.timesOperator,
              expectedTimes: performedNode.times,
            },
          ];
        } else {
          return [
            {
              stateId,
              condition,
              argMaxValue: `
                CASE
                  WHEN contact_or_anonymous_id IN (
                    SELECT DISTINCT contact_or_anonymous_id 
                    FROM contact_events 
                    WHERE event_name = 'contact_deleted'
                    GROUP BY contact_or_anonymous_id
                    HAVING argMax(occurred_at, occurred_at) > 0
                  ) THEN ''
                  ELSE toString(occurred_at)
                END
              `
                .replace(/\s+/g, ' ')
                .trim(),
              uniqValue: `message_id`,
              eventTimeExpression: `occurred_at`,
              recordMessageId: true,
              joinPriorStateValue: false,
              type: 'segment',
              computedPropertyId: segment.id,
            },
          ];
        }
      }

      case SegmentNodeType.LastPerformed: {
        const lastPerformedNode = node as any;
        if (!lastPerformedNode.event) {
          this.logger.warn(`LastPerformed node ${node.id} missing event`);
          return [];
        }

        let condition = `event_name = '${lastPerformedNode.event}'`;

        // Adicionar condições whereProperties se houver
        if (
          lastPerformedNode.whereProperties &&
          lastPerformedNode.whereProperties.length > 0
        ) {
          const propertyConditions = lastPerformedNode.whereProperties.map(
            (prop: any) => {
              const value = prop.operator?.value || '';
              const operator = prop.operator?.type || 'Equals';

              switch (operator) {
                case 'Equals':
                  return `JSONExtractString(properties, '${prop.path}') = '${value}'`;
                case 'NotEquals':
                  return `JSONExtractString(properties, '${prop.path}') != '${value}'`;
                case 'Contains':
                  return `JSONExtractString(properties, '${prop.path}') LIKE '%${value}%'`;
                case 'NotContains':
                  return `JSONExtractString(properties, '${prop.path}') NOT LIKE '%${value}%'`;
                case 'Exists':
                  return `JSONExtractString(properties, '${prop.path}') != ''`;
                default:
                  return `JSONExtractString(properties, '${prop.path}') = '${value}'`;
              }
            },
          );

          condition += ` AND (${propertyConditions.join(' AND ')})`;
        }

        // LastPerformed usa argMaxState para pegar o último evento
        return [
          {
            stateId,
            condition,
            argMaxValue: `
              CASE
                WHEN contact_or_anonymous_id IN (
                  SELECT DISTINCT contact_or_anonymous_id 
                  FROM contact_events 
                  WHERE event_name = 'contact_deleted'
                  GROUP BY contact_or_anonymous_id
                  HAVING argMax(occurred_at, occurred_at) > 0
                ) THEN ''
                ELSE toString(occurred_at)
              END
            `
              .replace(/\s+/g, ' ')
              .trim(),
            uniqValue: `message_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: true,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
          },
        ];
      }

      case SegmentNodeType.WhatsApp:
      case SegmentNodeType.Web:
      case SegmentNodeType.SMS: {
        const messageNode = node as any;
        const messageType = node.type.toLowerCase(); // whatsapp, web, sms

        // Para mensagens com template específico
        let condition = `event_name = '${messageType}_sent'`;

        if (messageNode.templateId) {
          condition += ` AND JSONExtractString(properties, 'template_id') = '${messageNode.templateId}'`;
        }

        if (messageNode.event) {
          // Se tiver um evento específico (MessageSent, MessageDelivered, etc.)
          const eventMap: Record<string, string> = {
            MessageSent: `${messageType}_sent`,
            MessageDelivered: `${messageType}_delivered`,
            MessageOpened: `${messageType}_opened`,
            MessageClicked: `${messageType}_clicked`,
            MessageFailed: `${messageType}_failed`,
          };
          condition = `event_name = '${eventMap[messageNode.event] || messageNode.event}'`;
        }

        return [
          {
            stateId,
            condition,
            argMaxValue: `
              CASE
                WHEN contact_or_anonymous_id IN (
                  SELECT DISTINCT contact_or_anonymous_id 
                  FROM contact_events 
                  WHERE event_name = 'contact_deleted'
                  GROUP BY contact_or_anonymous_id
                  HAVING argMax(occurred_at, occurred_at) > 0
                ) THEN ''
                ELSE toString(occurred_at)
              END
            `
              .replace(/\s+/g, ' ')
              .trim(),
            uniqValue: `message_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: true,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
          },
        ];
      }

      case SegmentNodeType.RandomBucket: {
        const bucketNode = node as any;
        const percent = bucketNode.percent || 0.5; // Default 50%

        // Usa hash do contact_or_anonymous_id para distribuição determinista
        const condition = `cityHash64(contact_or_anonymous_id) % 100 < ${Math.floor(percent * 100)}`;

        return [
          {
            stateId,
            condition,
            argMaxValue: `'true'`,
            uniqValue: `contact_or_anonymous_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: false,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
          },
        ];
      }

      case SegmentNodeType.Everyone: {
        return [
          {
            stateId,
            condition: `1 = 1`, // sempre verdadeiro
            argMaxValue: `
              CASE
                WHEN contact_or_anonymous_id IN (
                  SELECT DISTINCT contact_or_anonymous_id 
                  FROM contact_events 
                  WHERE event_name = 'contact_deleted'
                  GROUP BY contact_or_anonymous_id
                  HAVING argMax(occurred_at, occurred_at) > 0
                ) THEN 'false'
                ELSE 'true'
              END
            `,
            uniqValue: `contact_or_anonymous_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: false,
            joinPriorStateValue: false,
            type: 'segment',
            computedPropertyId: segment.id,
            validationInfo: {
              operator: 'Equals',
              value: 'true',
              extractPath: 'argMax',
            },
          },
        ];
      }

      case SegmentNodeType.Label: {
        const labelNode = node as any;
        if (!labelNode.labelId) {
          this.logger.warn(`Label node ${node.id} missing labelId`);
          return [];
        }

        switch (labelNode.condition) {
          case 'has':
            // For 'has', check current state using argMax of both add/remove events
            return [
              {
                stateId,
                condition: `(event_name = 'label_added' OR event_name = 'label_removed') AND JSONExtractString(properties, 'labelId') = '${labelNode.labelId}'`,
                argMaxValue: `
                  CASE
                    WHEN contact_or_anonymous_id IN (
                      SELECT DISTINCT contact_or_anonymous_id 
                      FROM contact_events 
                      WHERE event_name = 'contact_deleted'
                      GROUP BY contact_or_anonymous_id
                      HAVING argMax(occurred_at, occurred_at) > 0
                    ) THEN 'false'
                    ELSE if(event_name = 'label_added', 'true', 'false')
                  END
                `,
                uniqValue: `message_id`,
                eventTimeExpression: `occurred_at`,
                recordMessageId: false,
                joinPriorStateValue: false,
                type: 'segment' as const,
                computedPropertyId: segment.id,
                validationInfo: {
                  operator: 'Equals',
                  value: 'true',
                  extractPath: 'argMax',
                },
              },
            ];

          case 'not_has':
            // For 'not_has', we need to include ALL contacts, not just those with label events
            // This requires a different approach - we'll generate a subquery for contacts WITH the label
            // and then the final validation will exclude those
            return [
              {
                stateId,
                condition: `1 = 1`, // Include all contacts initially
                argMaxValue: `
                  CASE
                    WHEN contact_or_anonymous_id IN (
                      SELECT DISTINCT contact_or_anonymous_id 
                      FROM contact_events 
                      WHERE event_name = 'contact_deleted'
                      GROUP BY contact_or_anonymous_id
                      HAVING argMax(occurred_at, occurred_at) > 0
                    ) THEN 'false'
                    WHEN contact_or_anonymous_id IN (
                      SELECT DISTINCT contact_or_anonymous_id 
                      FROM contact_events 
                      WHERE (event_name = 'label_added' OR event_name = 'label_removed') 
                        AND JSONExtractString(properties, 'labelId') = '${labelNode.labelId}'
                      GROUP BY contact_or_anonymous_id
                      HAVING argMax(if(event_name = 'label_added', 'true', 'false'), occurred_at) = 'true'
                    ) THEN 'false'
                    ELSE 'true'
                  END
                `,
                uniqValue: `contact_or_anonymous_id`,
                eventTimeExpression: `occurred_at`,
                recordMessageId: false,
                joinPriorStateValue: false,
                type: 'segment' as const,
                computedPropertyId: segment.id,
                validationInfo: {
                  operator: 'Equals',
                  value: 'true',
                  extractPath: 'argMax',
                },
              },
            ];

          default:
            this.logger.warn(`Unknown label condition: ${labelNode.condition}`);
            return [];
        }
      }

      case SegmentNodeType.CustomAttribute: {
        const customAttrNode = node as any;
        if (!customAttrNode.attributeName) {
          this.logger.warn(
            `CustomAttribute node ${node.id} missing attributeName`,
          );
          return [];
        }

        // For CustomAttribute, check current value using argMax of all change events
        const operator = customAttrNode.operator?.type || 'Equals';
        const value = customAttrNode.operator?.value || '';

        // For NotEquals, NotContains, and similar "negative" conditions, we need to include ALL contacts
        // not just those who have custom attribute events
        if (operator === 'NotEquals' || operator === 'NotContains') {
          return [
            {
              stateId,
              condition: `1 = 1`, // Include all contacts initially
              argMaxValue: `
                CASE
                  WHEN contact_or_anonymous_id IN (
                    SELECT DISTINCT contact_or_anonymous_id 
                    FROM contact_events 
                    WHERE event_name = 'contact_deleted'
                    GROUP BY contact_or_anonymous_id
                    HAVING argMax(occurred_at, occurred_at) > 0
                  ) THEN 'false'
                  WHEN contact_or_anonymous_id IN (
                    SELECT DISTINCT contact_or_anonymous_id
                    FROM contact_events
                    WHERE event_name IN ('contact.custom_attribute.changed', 'custom_attribute_changed')
                      AND JSONExtractString(traits, 'attributeName') = '${customAttrNode.attributeName}'
                    GROUP BY contact_or_anonymous_id
                    HAVING argMax(
                      CASE
                        WHEN JSONExtractString(traits, 'changeType') = 'removed' THEN ''
                        ELSE JSONExtractString(traits, 'attributeValue')
                      END,
                      occurred_at
                    ) ${operator === 'NotEquals' ? '=' : 'LIKE'} ${operator === 'NotEquals' ? `'${value}'` : `'%${value}%'`}
                  ) THEN 'false'
                  ELSE 'true'
                END
              `,
              uniqValue: `contact_or_anonymous_id`,
              eventTimeExpression: `occurred_at`,
              recordMessageId: false,
              joinPriorStateValue: false,
              type: 'segment' as const,
              computedPropertyId: segment.id,
              validationInfo: {
                operator: 'Equals',
                value: 'true',
                extractPath: 'argMax',
              },
            },
          ];
        }

        // For positive conditions (Equals, Contains, etc.), use the original logic.
        // The custom-attribute change is an identify-DTO event: the CRM stores the
        // canonical dotted name and the payload in the `traits` column, not
        // `properties` (EVO-1839). Accept both event-name forms; read from traits.
        const condition = `event_name IN ('contact.custom_attribute.changed', 'custom_attribute_changed') AND JSONExtractString(traits, 'attributeName') = '${customAttrNode.attributeName}'`;

        // Get the current value using argMax - handle removed attributes as empty
        const argMaxValue = `
          CASE
            WHEN contact_or_anonymous_id IN (
              SELECT DISTINCT contact_or_anonymous_id
              FROM contact_events
              WHERE event_name = 'contact_deleted'
              GROUP BY contact_or_anonymous_id
              HAVING argMax(occurred_at, occurred_at) > 0
            ) THEN ''
            WHEN JSONExtractString(traits, 'changeType') = 'removed' THEN ''
            ELSE JSONExtractString(traits, 'attributeValue')
          END
        `
          .replace(/\s+/g, ' ')
          .trim();

        return [
          {
            stateId,
            condition,
            argMaxValue,
            uniqValue: `message_id`,
            eventTimeExpression: `occurred_at`,
            recordMessageId: false,
            joinPriorStateValue: false,
            type: 'segment' as const,
            computedPropertyId: segment.id,
            validationInfo: {
              operator,
              value,
              extractPath: 'argMax',
            },
          },
        ];
      }

      case SegmentNodeType.And:
      case SegmentNodeType.Or: {
        // Para nós compostos, processar recursivamente os filhos
        const compositeNode = node as AndSegmentNode | OrSegmentNode;
        if (!compositeNode.children) {
          return [];
        }

        // Para nós compostos, processar diretamente os filhos
        return compositeNode.children.flatMap((childId) => {
          // Children are IDs, not node objects
          // We need to find the actual node by ID
          const childNode = definition?.nodes?.find(
            (n: any) => n.id === childId,
          );
          if (childNode) {
            return this.segmentNodeToStateSubQuery(
              segment,
              childNode,
              definition,
            );
          }
          return [];
        });
      }

      default:
        this.logger.warn(`Unsupported segment node type: ${node.type}`);
        return [];
    }
  }

  /**
   * Generate validation for argMax expressions
   */
  generateArgMaxValidation(subQuery: StateSubQuery): string {
    if (!subQuery.validationInfo || !subQuery.argMaxValue) {
      // Validação padrão: verificar se o valor não está vazio
      const defaultValidation = `argMaxState(${subQuery.argMaxValue ?? "''"}, ce.occurred_at)`;
      this.logger.debug(
        `Default argMax validation for ${subQuery.stateId}: ${defaultValidation}`,
      );
      return defaultValidation;
    }

    const { operator, value, extractPath } = subQuery.validationInfo;
    const baseValue = subQuery.argMaxValue;

    this.logger.debug(
      `Generating argMax validation for ${subQuery.stateId}: operator=${operator}, value=${value}, extractPath=${extractPath}, baseValue=${baseValue}`,
    );

    // Labels não usam mais argMax - apenas strings/números normais
    {
      // Para campos string/número normais
      switch (operator) {
        case 'Equals':
          const equalsValidation = `argMaxState(if(${baseValue} = '${value}', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string Equals validation for ${subQuery.stateId}: ${equalsValidation}`,
          );
          return equalsValidation;
        case 'NotEquals':
          const notEqualsValidation = `argMaxState(if(${baseValue} != '${value}', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string NotEquals validation for ${subQuery.stateId}: ${notEqualsValidation}`,
          );
          return notEqualsValidation;
        case 'Contains':
          const containsStringValidation = `argMaxState(if(${baseValue} LIKE '%${value}%', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string Contains validation for ${subQuery.stateId}: ${containsStringValidation}`,
          );
          return containsStringValidation;
        case 'NotContains':
          const notContainsStringValidation = `argMaxState(if(${baseValue} NOT LIKE '%${value}%', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string NotContains validation for ${subQuery.stateId}: ${notContainsStringValidation}`,
          );
          return notContainsStringValidation;
        case 'GreaterThan':
          const gtValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) > ${value}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string GreaterThan validation for ${subQuery.stateId}: ${gtValidation}`,
          );
          return gtValidation;
        case 'GreaterThanOrEqual':
          const gteValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) >= ${value}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string GreaterThanOrEqual validation for ${subQuery.stateId}: ${gteValidation}`,
          );
          return gteValidation;
        case 'LessThan':
          const ltValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) < ${value}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string LessThan validation for ${subQuery.stateId}: ${ltValidation}`,
          );
          return ltValidation;
        case 'LessThanOrEqual':
          const lteValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) <= ${value}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string LessThanOrEqual validation for ${subQuery.stateId}: ${lteValidation}`,
          );
          return lteValidation;
        case 'Exists':
          const existsStringValidation = `argMaxState(if(${baseValue} != '', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string Exists validation for ${subQuery.stateId}: ${existsStringValidation}`,
          );
          return existsStringValidation;
        case 'NotExists':
          const notExistsStringValidation = `argMaxState(if(${baseValue} = '', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string NotExists validation for ${subQuery.stateId}: ${notExistsStringValidation}`,
          );
          return notExistsStringValidation;
        default:
          const validation = `argMaxState(if(${baseValue} != '', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated argMax validation for ${subQuery.stateId}: ${validation}`,
          );
          return validation;
      }
    }
  }

  /**
   * Get ClickHouse operator equivalent
   */
  getClickHouseOperator(operator: string): string {
    const operatorMap: Record<string, string> = {
      GreaterThanOrEqual: '>=',
      GreaterThan: '>',
      LessThanOrEqual: '<=',
      LessThan: '<',
      Equals: '=',
      NotEquals: '!=',
    };

    return operatorMap[operator] || operator;
  }

  /**
   * Generate consistent state ID
   */
  generateStateId(segment: Segment, nodeId: string): string {
    return `${segment.id}_${nodeId}`;
  }
}
