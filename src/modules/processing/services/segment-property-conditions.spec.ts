import { AtomicSegmentProcessor } from './atomic-processor.service';
import { BatchProcessorService } from './batch-processor.service';
import { SegmentQueryUtils } from '../../segments/utils/segment-query.utils';

/**
 * CRM-241 follow-up: the real-time processors carried their own copies of the
 * event-property filter, reading only `properties` and interpolating the path
 * and the value without escaping. Both now go through the shared builder.
 *
 * The builders are private and use no injected dependency, so the tests call
 * them on a bare prototype instead of booting the Nest module.
 */
const atomic = Object.create(
  AtomicSegmentProcessor.prototype,
) as AtomicSegmentProcessor;
const batch = Object.create(
  BatchProcessorService.prototype,
) as BatchProcessorService;

const performedNode = (properties: unknown[]) => ({
  id: 'n1',
  type: 'Performed',
  event: 'contact.label.added',
  properties,
});

const labelFilter = {
  path: 'labelName',
  operator: { type: 'Equals', value: 'VIP' },
};

describe('CRM-241 real-time processors share the event-property builder', () => {
  const expected = (alias = '') =>
    `${SegmentQueryUtils.extractEventProperty('labelName', alias)} = 'VIP'`;

  it('AtomicSegmentProcessor.buildNodeLogicForBatch falls back to traits', () => {
    const sql = (atomic as any).buildNodeLogicForBatch(
      performedNode([labelFilter]),
    );

    expect(sql).toContain(expected());
    expect(sql).not.toContain(`JSONExtractString(properties, 'labelName')`);
  });

  it('AtomicSegmentProcessor.buildNodeLogic falls back to traits', () => {
    const sql = (atomic as any).buildNodeLogic(performedNode([labelFilter]));

    expect(sql).toContain(expected());
    expect(sql).not.toContain(`JSONExtractString(properties, 'labelName')`);
  });

  it('BatchProcessorService.buildSegmentLogic falls back to traits, aliased', () => {
    const sql = (batch as any).buildSegmentLogic({
      entryNode: { type: 'And' },
      nodes: [performedNode([labelFilter])],
    });

    expect(sql).toContain(expected('ce'));
    expect(sql).not.toContain(`JSONExtractString(ce.properties, 'labelName')`);
  });

  // The batch copy read `prop.key`/`prop.value`, a shape the frontend never
  // emits, so its filter resolved to the literal string "undefined".
  it('BatchProcessorService no longer reads the wrong property shape', () => {
    const sql = (batch as any).buildSegmentLogic({
      entryNode: { type: 'And' },
      nodes: [performedNode([labelFilter])],
    });

    expect(sql).not.toContain('undefined');
  });

  it.each([
    ['buildNodeLogicForBatch'],
    ['buildNodeLogic'],
  ])('%s escapes a quote in the path and in the value', (method) => {
    const sql = (atomic as any)[method](
      performedNode([
        { path: "label'--", operator: { type: 'Equals', value: "VIP'--" } },
      ]),
    );

    expect(sql).toContain(`label''--`);
    expect(sql).toContain(`VIP''--`);
  });

  it('escapes a quote in the event name', () => {
    const sql = (atomic as any).buildNodeLogicForBatch({
      id: 'n1',
      type: 'Performed',
      event: "evt'--",
      properties: [],
    });

    expect(sql).toBe(`event_name = 'evt''--'`);
  });
});
