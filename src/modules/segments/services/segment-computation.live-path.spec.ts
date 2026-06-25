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
});
