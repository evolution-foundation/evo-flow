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
 * NOTE: the analogous LIVE read-path propagation test
 * (SegmentComputationService.getSegmentContacts throwing on a ClickHouse
 * failure instead of returning []) cannot be compiled under ts-jest right now
 * because importing SegmentComputationService pulls in
 * processing/clickhouse/clickhouse.service.ts, which currently has duplicate
 * `ensureKafkaEngineBroker`/`extractKafkaBrokers` implementations (a develop
 * regression from the #87 / #101 merge) that fails TS2393. The same regression
 * blocks the pre-existing segment-job.service.spec.ts. The read-path code fix
 * (log ERROR + throw) is in segment-computation.service.ts.
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
});
