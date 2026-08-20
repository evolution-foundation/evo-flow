import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { SegmentNodeType } from '../entities/segment.entity';

/**
 * EVO-1901 — exercises the LIVE segment recompute SQL path.
 *
 * The dead `segment-builders/*` + `SegmentBuilderFactory` graph (reached only
 * via `createBuilder`, which had NO caller anywhere in src) was removed: that
 * was where the previous fix renamed JSON_EXTRACT_STRING, with zero runtime
 * effect. The real recompute SQL is produced by
 * SegmentClickHouseQueryBuilderService.segmentNodeToStateSubQuery
 * (modular-segment-computation.service.ts STAGE 1), which this test asserts
 * emits the valid ClickHouse function JSONExtractString.
 *
 * The analogous LIVE read-path propagation (N9) is covered by
 * segment-computation.n9-propagation.spec.ts. That spec imports
 * SegmentComputationService, which was previously uncompilable under ts-jest
 * because processing/clickhouse/clickhouse.service.ts had duplicate
 * `ensureKafkaEngineBroker`/`extractKafkaBrokers` implementations (TS2393, a
 * develop regression from the #87 / #101 merge). That regression — which also
 * blocked the pre-existing segment-job.service.spec.ts — was deduped on develop
 * by EVO-1966, so the N9 spec now compiles and runs.
 */
describe('EVO-1901 live segment recompute SQL builder', () => {
  const builder = new SegmentClickHouseQueryBuilderService();

  it('emits the valid ClickHouse function JSONExtractString, never JSON_EXTRACT_STRING', () => {
    const segment = { id: 'seg-1' } as any;
    const node = { id: 'n1', type: SegmentNodeType.Email } as any;

    const subQueries = builder.segmentNodeToStateSubQuery(segment, node);

    const serialized = JSON.stringify(subQueries);
    expect(serialized).toContain('JSONExtractString');
    expect(serialized).not.toContain('JSON_EXTRACT_STRING');
  });

  // EVO-1901 (D12) real fix: a custom-attribute condition must read the delta
  // event stream (`contact.custom_attribute.changed` → attributeName/attributeValue),
  // NOT a flat `traits.<attr>` key. The flat extraction matched zero rows, which
  // is what made conditional segments compute 0 members (verified against live
  // ClickHouse: flat `JSONExtractString(traits,'tier')` → 0 contacts; delta
  // approach → the real members).
  it('reads custom attributes from the delta stream, not a flat traits key', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.UserProperty,
      path: 'customAttributes.tier',
      operator: { type: 'Equals', value: 'platinum' },
      value: 'platinum',
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain('contact.custom_attribute.changed');
    expect(subQuery.condition).toContain('custom_attribute_changed');
    expect(subQuery.condition).toContain(
      "JSONExtractString(traits, 'attributeName') = 'tier'",
    );
    // …and argMaxes the delta value (cleared on removal)…
    expect(subQuery.argMaxValue).toContain(
      "JSONExtractString(traits, 'attributeValue')",
    );
    expect(subQuery.argMaxValue).toContain("'changeType'");
    // …never the broken flat extraction that matched nothing.
    expect(subQuery.condition).not.toContain(
      "JSONExtractString(traits, 'tier')",
    );
    expect(subQuery.argMaxValue).not.toContain(
      "JSONExtractString(traits, 'tier')",
    );
    expect(subQuery.validationInfo?.operator).toBe('Equals');
    expect(subQuery.validationInfo?.value).toBe('platinum');
  });

  // EVO-1901 (review req-1) — the shape the FRONTEND actually serializes for a
  // custom-attribute condition is a dedicated CustomAttribute node
  // (`{ type:'CustomAttribute', attributeName, operator }`), NOT a UserProperty
  // `path`. It must dispatch to `case SegmentNodeType.CustomAttribute` and read
  // the delta stream by attributeName. This locks the live FE path so it can
  // never silently regress to a flat `traits` key (0 members).
  it('FE CustomAttribute node dispatches to the delta-stream case (not a flat traits key)', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.CustomAttribute,
      attributeName: 'tier',
      operator: { type: 'Equals', value: 'platinum' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain(
      "JSONExtractString(traits, 'attributeName') = 'tier'",
    );
    expect(subQuery.condition).toContain('contact.custom_attribute.changed');
    expect(subQuery.argMaxValue).toContain(
      "JSONExtractString(traits, 'attributeValue')",
    );
    // never the flat extraction that matched nothing
    expect(subQuery.condition).not.toContain(
      "JSONExtractString(traits, 'tier')",
    );
  });

  // EVO-1901 (review req-1) — the legacy bare `path:'customAttributes'` +
  // operator.value branch used to emit the flat
  // `JSONExtractString(traits,'customAttributes.<name>')` extraction, silently
  // computing 0 members (the D12 symptom). It must now read the delta stream by
  // attributeName instead, so a legacy definition never yields a silent empty
  // segment.
  it('legacy bare customAttributes path reads the delta stream, not a silent flat key', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.UserProperty,
      path: 'customAttributes',
      operator: { type: 'Equals', value: 'tier' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain(
      "JSONExtractString(traits, 'attributeName') = 'tier'",
    );
    expect(subQuery.condition).not.toContain(
      "JSONExtractString(traits, 'customAttributes.tier')",
    );
    expect(subQuery.argMaxValue).not.toContain(
      "JSONExtractString(traits, 'customAttributes.tier')",
    );
  });
});

describe('segment recompute SQL builder escapes user-controlled values', () => {
  const builder = new SegmentClickHouseQueryBuilderService();

  it('escapes a single quote in a CustomAttribute value instead of splicing it into the SQL', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.CustomAttribute,
      attributeName: 'tier',
      operator: { type: 'Equals', value: `platinum' OR '1'='1` },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).not.toContain(`platinum' OR '1'='1`);
    expect(subQuery.validationInfo?.value).toBe(`platinum' OR '1'='1`);
  });

  it('escapes a single quote in the attributeName used to filter events', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.CustomAttribute,
      attributeName: `tier' OR '1'='1`,
      operator: { type: 'Equals', value: 'platinum' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).not.toContain(`tier' OR '1'='1`);
    expect(subQuery.condition).toContain(`tier'' OR ''1''=''1`);
  });

  it('escapes a single quote in a Performed event property path and value', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.Performed,
      event: 'order_placed',
      properties: [
        {
          path: `plan' OR '1'='1`,
          operator: { type: 'Equals', value: `gold' OR '1'='1` },
        },
      ],
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).not.toContain(`plan' OR '1'='1`);
    expect(subQuery.condition).not.toContain(`gold' OR '1'='1`);
  });

  it('escapes a single quote in a Label labelId', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.Label,
      labelId: `vip' OR '1'='1`,
      condition: 'has',
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).not.toContain(`vip' OR '1'='1`);
  });

  it('escapes a single quote in a WhatsApp templateId', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.WhatsApp,
      templateId: `welcome' OR '1'='1`,
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).not.toContain(`welcome' OR '1'='1`);
  });

  it('falls back to a null numeric literal for a non-numeric GreaterThan value, instead of splicing raw text', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.UserProperty,
      path: 'leadScore',
      operator: { type: 'GreaterThan', value: '0 OR 1=1' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);
    const validation = builder.generateArgMaxValidation(subQuery);

    expect(validation).not.toContain('0 OR 1=1');
    expect(validation).toContain('null');
  });
});

describe('custom attribute sub-query is shared between both entry points', () => {
  const builder = new SegmentClickHouseQueryBuilderService();

  it('generates the same NotEquals sub-query for the CustomAttribute node and the UserProperty path', () => {
    const segment = { id: 'seg-1' } as any;

    const [fromCustomAttributeNode] = builder.segmentNodeToStateSubQuery(
      segment,
      {
        id: 'n1',
        type: SegmentNodeType.CustomAttribute,
        attributeName: 'tier',
        operator: { type: 'NotEquals', value: 'platinum' },
      } as any,
    );
    const [fromUserPropertyPath] = builder.segmentNodeToStateSubQuery(
      segment,
      {
        id: 'n2',
        type: SegmentNodeType.UserProperty,
        path: 'customAttributes.tier',
        operator: { type: 'NotEquals', value: 'platinum' },
      } as any,
    );

    expect(fromUserPropertyPath.condition).toBe(fromCustomAttributeNode.condition);
    expect(fromUserPropertyPath.argMaxValue).toBe(
      fromCustomAttributeNode.argMaxValue,
    );
    expect(fromUserPropertyPath.condition).toBe('1 = 1');
  });

  it('a NotExists condition includes a contact who never triggered the attribute event', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.CustomAttribute,
      attributeName: 'tier',
      operator: { type: 'NotExists', value: '' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toBe('1 = 1');
    expect(subQuery.argMaxValue).toContain("THEN 'false'");
    expect(subQuery.argMaxValue).toContain("ELSE 'true'");
  });

  it('an Exists condition still only matches contacts with an event (no regression)', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.CustomAttribute,
      attributeName: 'tier',
      operator: { type: 'Exists', value: '' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain('contact.custom_attribute.changed');
    expect(subQuery.condition).not.toBe('1 = 1');
  });
});

describe('remaining user-controlled interpolation points fail closed (CRM-60 review)', () => {
  const builder = new SegmentClickHouseQueryBuilderService();

  it('maps known times operators and refuses an unmapped one instead of returning it raw', () => {
    expect(builder.getClickHouseOperator('GreaterThanOrEqual')).toBe('>=');
    expect(builder.getClickHouseOperator(`= 0 OR 1=1 --`)).toBeNull();
  });

  it('strips quote and backslash from the node id embedded in the state id', () => {
    const segment = { id: 'seg-1' } as any;

    expect(builder.generateStateId(segment, `n1' OR '1'='1`)).toBe(
      'seg-1_n1 OR 1=1',
    );
  });

  it('a RandomBucket percent of 0 selects an empty bucket; a non-numeric one falls back to 50%', () => {
    const segment = { id: 'seg-1' } as any;

    const [zeroBucket] = builder.segmentNodeToStateSubQuery(segment, {
      id: 'n1',
      type: SegmentNodeType.RandomBucket,
      percent: 0,
    } as any);
    const [defaultBucket] = builder.segmentNodeToStateSubQuery(segment, {
      id: 'n2',
      type: SegmentNodeType.RandomBucket,
      percent: 'abc',
    } as any);

    expect(zeroBucket.condition).toContain('< 0');
    expect(defaultBucket.condition).toContain('< 50');
  });

  it('does not resolve prototype properties when mapping a message event name', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.WhatsApp,
      event: 'toString',
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toBe(`event_name = 'toString'`);
  });

  it('escapes LIKE wildcards in a Contains value so % only matches itself', () => {
    const segment = { id: 'seg-1' } as any;
    const node = {
      id: 'n1',
      type: SegmentNodeType.UserProperty,
      path: 'plan',
      operator: { type: 'Contains', value: '50%' },
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain(`LIKE '%50\\\\%%'`);
  });
});
