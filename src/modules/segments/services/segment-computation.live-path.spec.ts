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

    // Selects the attribute's change events…
    expect(subQuery.condition).toContain(
      "event_name = 'contact.custom_attribute.changed'",
    );
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
