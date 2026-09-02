import { Injectable } from '@nestjs/common';
import { Segment } from '../entities/segment.entity';
import {
  SegmentNode,
  SegmentNodeType,
  AndSegmentNode,
  OrSegmentNode,
} from '../entities/segment.entity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import { SegmentQueryUtils } from '../utils/segment-query.utils';
import {
  DELETED_CONTACTS_SUBQUERY,
  LABEL_ADDED_EVENT_NAMES,
  LABEL_REMOVED_EVENT_NAMES,
  sqlStringList,
} from '../queries/contact-event-names';

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

  private escapeSql(value: unknown): string {
    return SegmentQueryUtils.sanitizeStringValue(String(value ?? ''));
  }

  private escapeNumeric(value: unknown): string {
    return SegmentQueryUtils.sanitizeNumericValue(value);
  }

  private escapeLike(value: unknown): string {
    return SegmentQueryUtils.sanitizeLikeValue(value);
  }

  // CRM-241: one event-property filter, for Performed AND LastPerformed, shared
  // with the real-time processors that carried their own drifted copies. It picks
  // the column at query time because contact events are emitted as `identify`,
  // which fills `traits` and leaves `properties` at `{}`. See SegmentQueryUtils.
  private buildEventPropertyCondition(prop: any): string {
    return SegmentQueryUtils.buildEventPropertyCondition(
      prop,
      '',
      (operator, path) =>
        this.logger.warn(
          `Unknown property operator '${operator}' on path '${path}'; ` +
            `falling back to equality.`,
        ),
    );
  }

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
        // EVO-1901 (D12): custom attributes are ingested as delta events
        // (`contact.custom_attribute.changed`) carrying { attributeName,
        // attributeValue, changeType }, NOT as a flat or nested `traits` key. The
        // generic `JSONExtractString(traits, '<attr>')` extraction below never
        // matches them (→ 0 members). When this flag is set, the condition +
        // argMaxValue are overridden further down to read the delta stream.
        let isCustomAttribute = false;
        let customAttributeName = '';

        // Determinar como extrair o valor baseado no path
        if (userPropNode.path === 'labels') {
          // Labels agora são eventos separados (label_added/label_removed)
          // Este caso não deveria mais ser usado, mas manter para compatibilidade
          extractPath = 'labels';
          useArgMax = false; // Usar lógica simples
        } else if (userPropNode.path === 'customAttributes') {
          // EVO-1901 (D12 / review req-1): legacy, degenerate shape. The current
          // frontend NEVER emits this — a custom-attribute condition is
          // serialized as a dedicated `{ type:'CustomAttribute', attributeName,
          // operator }` node, handled by the `case SegmentNodeType.CustomAttribute`
          // branch below (which reads the delta stream). Verified by executing
          // segmentNodeToStateSubQuery against the FE node shape: it dispatches to
          // `case CustomAttribute`, never here. A bare `path:'customAttributes'`
          // carries the attribute name in `operator.value`; left as the old flat
          // `JSONExtractString(traits,'customAttributes.<name>')` extraction it
          // matched zero rows and computed 0 members *silently* — the exact D12
          // symptom. Route it through the same delta-stream read as the dotted
          // branch and WARN, so a hit from a legacy definition is visible instead
          // of a silent empty segment (never a silent 0).
          if (userPropNode.operator?.value) {
            customAttributeName = userPropNode.operator.value;
            extractPath = customAttributeName;
            isCustomAttribute = true;
          } else {
            extractPath = 'customAttributes';
          }
          useArgMax = true; // Custom attributes podem mudar
          this.logger.warn(
            `Segment node ${userPropNode.id ?? '?'} uses the legacy bare ` +
              `'customAttributes' UserProperty path (attributeName=` +
              `'${userPropNode.operator?.value ?? ''}'). The frontend now emits a ` +
              `dedicated CustomAttribute node; this path is only reachable from ` +
              `legacy segment definitions and is read via the delta stream.`,
          );
        } else if (userPropNode.path.startsWith('customAttributes.')) {
          // EVO-1901 (D12): the custom attribute is NOT a flat `traits.<attr>` key
          // (the previous assumption) — it arrives as a delta event. Capture the
          // attribute name; the condition + argMaxValue are overridden below to
          // read `contact.custom_attribute.changed` events.
          customAttributeName = userPropNode.path.replace('customAttributes.', '');
          extractPath = customAttributeName;
          isCustomAttribute = true;
          useArgMax = true; // Custom attributes podem mudar
          this.logger.debug(
            `Custom attribute mapping: path=${userPropNode.path}, attributeName=${customAttributeName}`,
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

        if (isCustomAttribute) {
          const attributeOperator = userPropNode.operator
            ? typeof userPropNode.operator === 'object'
              ? userPropNode.operator.type
              : userPropNode.operator
            : '';
          const attributeValue = userPropNode.operator
            ? typeof userPropNode.operator === 'object'
              ? String(userPropNode.operator.value || '')
              : String(userPropNode.value || '')
            : '';

          return this.buildCustomAttributeSubQuery(
            stateId,
            segment,
            customAttributeName,
            attributeOperator,
            attributeValue,
          );
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
                condition = `has(JSONExtractArrayRaw(traits, 'labels'), '"${this.escapeSql(value)}"')`;
                break;
              case 'NotContains':
                condition = `NOT has(JSONExtractArrayRaw(traits, 'labels'), '"${this.escapeSql(value)}"')`;
                break;
              case 'Exists':
                condition = `JSONExtractArrayRaw(traits, 'labels') != '[]'`;
                break;
              case 'NotExists':
                condition = `JSONExtractArrayRaw(traits, 'labels') = '[]'`;
                break;
              default:
                condition = `has(JSONExtractArrayRaw(traits, 'labels'), '"${this.escapeSql(value)}"')`;
            }
          } else {
            // Para campos string/número - para campos mutáveis, não usar argMax na condição WHERE
            // A condição inicial será sempre verdadeira e a validação será feita no argMaxValue
            if (useArgMax) {
              // Para campos mutáveis: condição sempre verdadeira, validação no argMaxValue
              condition = `JSONExtractString(traits, '${this.escapeSql(extractPath)}') != ''`; // Sempre inclui se o campo existe
            } else {
              // Para campos imutáveis: aplicar condição diretamente
              const extractFunc = `JSONExtractString(traits, '${this.escapeSql(extractPath)}')`;
              const escapedValue = this.escapeSql(value);
              const likeValue = this.escapeLike(value);
              const numericValue = this.escapeNumeric(value);

              switch (operator) {
                case 'Equals':
                  condition = `${extractFunc} = '${escapedValue}'`;
                  break;
                case 'NotEquals':
                  condition = `${extractFunc} != '${escapedValue}'`;
                  break;
                case 'Contains':
                  condition = `${extractFunc} LIKE '%${likeValue}%'`;
                  break;
                case 'NotContains':
                  condition = `${extractFunc} NOT LIKE '%${likeValue}%'`;
                  break;
                case 'GreaterThan':
                  condition = `toFloat64OrNull(${extractFunc}) > ${numericValue}`;
                  break;
                case 'GreaterThanOrEqual':
                  condition = `toFloat64OrNull(${extractFunc}) >= ${numericValue}`;
                  break;
                case 'LessThan':
                  condition = `toFloat64OrNull(${extractFunc}) < ${numericValue}`;
                  break;
                case 'LessThanOrEqual':
                  condition = `toFloat64OrNull(${extractFunc}) <= ${numericValue}`;
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
          condition = `JSONExtractString(traits, '${this.escapeSql(extractPath)}') != ''`;
        }

        // Definir argMaxValue baseado na estratégia
        if (useArgMax) {
          // Para campos que usam argMax (sem labels) - adicionar verificação de contatos deletados
          argMaxValue = `
            CASE
              WHEN contact_or_anonymous_id IN (
                ${DELETED_CONTACTS_SUBQUERY}
              ) THEN ''
              ELSE JSONExtractString(traits, '${this.escapeSql(extractPath)}')
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
                  ${DELETED_CONTACTS_SUBQUERY}
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
                  ${DELETED_CONTACTS_SUBQUERY}
                ) THEN ''
                ELSE JSONExtractString(traits, '${this.escapeSql(userPropNode.path)}')
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

        let condition = `event_name = '${this.escapeSql(performedNode.event)}'`;

        // Adicionar condições de propriedades se houver
        if (performedNode.properties && performedNode.properties.length > 0) {
          const propertyConditions = performedNode.properties.map((prop: any) =>
            this.buildEventPropertyCondition(prop),
          );

          condition += ` AND (${propertyConditions.join(' AND ')})`;
        }

        // Adicionar janela de tempo se especificada
        if (performedNode.withinSeconds) {
          condition += ` AND occurred_at >= now() - INTERVAL ${this.escapeNumeric(performedNode.withinSeconds)} SECOND`;
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
                    ${DELETED_CONTACTS_SUBQUERY}
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

        let condition = `event_name = '${this.escapeSql(lastPerformedNode.event)}'`;

        // Adicionar condições whereProperties se houver
        if (
          lastPerformedNode.whereProperties &&
          lastPerformedNode.whereProperties.length > 0
        ) {
          const propertyConditions = lastPerformedNode.whereProperties.map(
            (prop: any) => this.buildEventPropertyCondition(prop),
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
                  ${DELETED_CONTACTS_SUBQUERY}
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
          condition += ` AND JSONExtractString(properties, 'template_id') = '${this.escapeSql(messageNode.templateId)}'`;
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
          // Own-key check: a prototype name like 'toString' must not resolve
          // an inherited function into the SQL literal.
          const resolvedEvent = Object.hasOwn(eventMap, messageNode.event)
            ? eventMap[messageNode.event]
            : this.escapeSql(messageNode.event);
          condition = `event_name = '${resolvedEvent}'`;
        }

        return [
          {
            stateId,
            condition,
            argMaxValue: `
              CASE
                WHEN contact_or_anonymous_id IN (
                  ${DELETED_CONTACTS_SUBQUERY}
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
        const percent = Number(bucketNode.percent);
        const safePercent = Number.isFinite(percent) ? percent : 0.5; // Default 50%

        // Usa hash do contact_or_anonymous_id para distribuição determinista
        const condition = `cityHash64(contact_or_anonymous_id) % 100 < ${Math.floor(safePercent * 100)}`;

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
                  ${DELETED_CONTACTS_SUBQUERY}
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

        const labelId = this.escapeSql(labelNode.labelId);
        const LABEL_ADDED_IN = sqlStringList(LABEL_ADDED_EVENT_NAMES);
        const LABEL_EVENTS_IN = sqlStringList([...LABEL_ADDED_EVENT_NAMES, ...LABEL_REMOVED_EVENT_NAMES]);
        // Definitions saved by the old editor hold the label TITLE instead of its id, and
        // there is no backfill. Every contact.label.* event carries both in traits, so
        // match either — a stored title keeps working without reopening the segment (CRM-215).
        const LABEL_MATCH =
          `(JSONExtractString(traits, 'labelId') = '${labelId}'` +
          ` OR JSONExtractString(traits, 'labelName') = '${labelId}')`;

        switch (labelNode.condition) {
          case 'has':
            // For 'has', check current state using argMax of both add/remove events
            return [
              {
                stateId,
                condition: `event_name IN (${LABEL_EVENTS_IN}) AND ${LABEL_MATCH}`,
                argMaxValue: `
                  CASE
                    WHEN contact_or_anonymous_id IN (
                      ${DELETED_CONTACTS_SUBQUERY}
                    ) THEN 'false'
                    ELSE if(event_name IN (${LABEL_ADDED_IN}), 'true', 'false')
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
                      ${DELETED_CONTACTS_SUBQUERY}
                    ) THEN 'false'
                    WHEN contact_or_anonymous_id IN (
                      SELECT DISTINCT contact_or_anonymous_id
                      FROM contact_events
                      WHERE event_name IN (${LABEL_EVENTS_IN})
                        AND ${LABEL_MATCH}
                      GROUP BY contact_or_anonymous_id
                      HAVING argMax(if(event_name IN (${LABEL_ADDED_IN}), 'true', 'false'), occurred_at) = 'true'
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

        return this.buildCustomAttributeSubQuery(
          stateId,
          segment,
          customAttrNode.attributeName,
          customAttrNode.operator?.type || 'Equals',
          customAttrNode.operator?.value || '',
        );
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

  // Shared by the CustomAttribute node and the legacy UserProperty
  // customAttributes[.<attr>] path. NotEquals/NotContains/NotExists also
  // need to match contacts with no event for the attribute (e.g. "not equal
  // to X" is trivially true for them), so those three include every contact
  // up front and flip back to false via a subquery on the positive match.
  private buildCustomAttributeSubQuery(
    stateId: string,
    segment: Segment,
    attributeName: string,
    operator: string,
    value: string,
  ): StateSubQuery[] {
    const escapedAttributeName = this.escapeSql(attributeName);
    const escapedValue = this.escapeSql(value);
    const negatedOperators = ['NotEquals', 'NotContains', 'NotExists'];

    if (negatedOperators.includes(operator)) {
      const currentValueExpr = `
        CASE
          WHEN JSONExtractString(traits, 'changeType') = 'removed' THEN ''
          ELSE JSONExtractString(traits, 'attributeValue')
        END
      `
        .replace(/\s+/g, ' ')
        .trim();

      const positiveComparison =
        operator === 'NotEquals'
          ? `= '${escapedValue}'`
          : operator === 'NotContains'
            ? `LIKE '%${this.escapeLike(value)}%'`
            : `!= ''`; // NotExists: flip back to false when a current value exists

      return [
        {
          stateId,
          condition: `1 = 1`, // Include all contacts initially
          argMaxValue: `
            CASE
              WHEN contact_or_anonymous_id IN (
                ${DELETED_CONTACTS_SUBQUERY}
              ) THEN 'false'
              WHEN contact_or_anonymous_id IN (
                SELECT DISTINCT contact_or_anonymous_id
                FROM contact_events
                WHERE event_name IN ('contact.custom_attribute.changed', 'custom_attribute_changed')
                  AND JSONExtractString(traits, 'attributeName') = '${escapedAttributeName}'
                GROUP BY contact_or_anonymous_id
                HAVING argMax(${currentValueExpr}, occurred_at) ${positiveComparison}
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

    // Positive conditions: a contact with no matching event correctly has
    // no row and is excluded.
    const condition = `event_name IN ('contact.custom_attribute.changed', 'custom_attribute_changed') AND JSONExtractString(traits, 'attributeName') = '${escapedAttributeName}'`;

    const argMaxValue = `
      CASE
        WHEN contact_or_anonymous_id IN (
          ${DELETED_CONTACTS_SUBQUERY}
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

    const { operator, extractPath } = subQuery.validationInfo;
    const value = this.escapeSql(subQuery.validationInfo.value);
    const likeValue = this.escapeLike(subQuery.validationInfo.value);
    const numericValue = this.escapeNumeric(subQuery.validationInfo.value);
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
          const containsStringValidation = `argMaxState(if(${baseValue} LIKE '%${likeValue}%', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string Contains validation for ${subQuery.stateId}: ${containsStringValidation}`,
          );
          return containsStringValidation;
        case 'NotContains':
          const notContainsStringValidation = `argMaxState(if(${baseValue} NOT LIKE '%${likeValue}%', '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string NotContains validation for ${subQuery.stateId}: ${notContainsStringValidation}`,
          );
          return notContainsStringValidation;
        case 'GreaterThan':
          const gtValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) > ${numericValue}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string GreaterThan validation for ${subQuery.stateId}: ${gtValidation}`,
          );
          return gtValidation;
        case 'GreaterThanOrEqual':
          const gteValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) >= ${numericValue}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string GreaterThanOrEqual validation for ${subQuery.stateId}: ${gteValidation}`,
          );
          return gteValidation;
        case 'LessThan':
          const ltValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) < ${numericValue}, '1', ''), ce.occurred_at)`;
          this.logger.debug(
            `Generated string LessThan validation for ${subQuery.stateId}: ${ltValidation}`,
          );
          return ltValidation;
        case 'LessThanOrEqual':
          const lteValidation = `argMaxState(if(toFloat64OrNull(${baseValue}) <= ${numericValue}, '1', ''), ce.occurred_at)`;
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
  getClickHouseOperator(operator: string): string | null {
    const operatorMap: Record<string, string> = {
      GreaterThanOrEqual: '>=',
      GreaterThan: '>',
      LessThanOrEqual: '<=',
      LessThan: '<',
      Equals: '=',
      NotEquals: '!=',
    };

    // Fail closed: an unmapped operator is user input and must never reach
    // the SQL raw. Callers turn null into a no-match comparison.
    return operatorMap[operator] ?? null;
  }

  /**
   * Generate consistent state ID
   */
  generateStateId(segment: Segment, nodeId: string): string {
    // node.id comes from the user-authored definition and this id is inlined
    // into SQL literals downstream; strip quote/backslash so it can't break one.
    return `${segment.id}_${String(nodeId ?? '').replace(/['\\]/g, '')}`;
  }
}
