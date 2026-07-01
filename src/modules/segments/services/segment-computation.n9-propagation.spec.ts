import { SegmentComputationService } from './segment-computation.service';

/**
 * EVO-1901 (N9) — a ClickHouse failure in the segment READ path must PROPAGATE,
 * not be swallowed into "empty segment" / "contact in no segment". Before the
 * fix, `getSegmentContacts`/`getContactSegments`/`isContactInSegment` caught the
 * error and returned `[]`/`false`, making a broken ClickHouse indistinguishable
 * from a genuinely empty result — the same silent-failure class as D12.
 *
 * This compiles again now that the develop TS2393 regression in
 * clickhouse.service.ts (duplicate ensureKafkaEngineBroker/extractKafkaBrokers)
 * was deduped by EVO-1966; importing SegmentComputationService no longer fails.
 */
describe('EVO-1901 (N9) segment read-path propagates ClickHouse errors', () => {
  const chError = new Error('ClickHouse down: connection refused');

  function buildService() {
    const clickhouseService = {
      // getSegmentContacts builds a parameterized query first
      createQueryBuilder: () => ({
        addParameter: () => '{p:String}',
        build: () => ({ parameters: {} }),
      }),
      // every read method funnels through query() — make it fail
      query: jest.fn().mockRejectedValue(chError),
    };

    const service = new SegmentComputationService(
      {} as any, // TenantDbContext
      {} as any, // ModularSegmentComputationService
      clickhouseService as any, // ClickHouseService
      {} as any, // SegmentCacheService
      { emit: () => undefined } as any, // EventEmitter2
    );
    return { service, clickhouseService };
  }

  it('getSegmentContacts rejects instead of returning []', async () => {
    const { service } = buildService();
    await expect(service.getSegmentContacts('seg-1', 10, 0)).rejects.toThrow(
      chError,
    );
  });

  it('getContactSegments rejects instead of returning []', async () => {
    const { service } = buildService();
    await expect(service.getContactSegments('contact-1')).rejects.toThrow(
      chError,
    );
  });

  it('isContactInSegment rejects instead of returning false', async () => {
    const { service } = buildService();
    await expect(
      service.isContactInSegment('contact-1', 'seg-1'),
    ).rejects.toThrow(chError);
  });
});
