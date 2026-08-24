import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { Segment, SegmentNodeType } from '../entities/segment.entity';

/**
 * CRM-241: whereProperties filters used to read only the `properties` column.
 * Contact events reach ClickHouse as `identify`, which puts the whole payload
 * in `traits` and leaves `properties` at `{}` — so those filters matched
 * nothing, and failed silently in both directions (Equals returned an empty
 * segment, NotEquals let every contact through).
 *
 * Verified against a real event posted through POST /api/v1/events/identify:
 *   properties: {}
 *   traits:     {"labelName":"VIP","labelId":"lb-99","source":"crm"}
 * With the old expression, `= 'VIP'` was 0 and `!= 'VIP'` was 1. With the new
 * one, 1 and 0 respectively — while a `track` row (properties filled, traits
 * `{}`) evaluated identically under both.
 *
 * This spec pins the SQL. That the SQL actually MATCHES the right rows is proved
 * by test/segment-where-properties.e2e-spec.ts, which runs it against a live
 * ClickHouse (green on both environments: community 26.7 and ecosystem 25.8).
 */
describe('SegmentClickHouseQueryBuilderService — whereProperties (CRM-241)', () => {
  const service = new SegmentClickHouseQueryBuilderService();
  const segment = { id: 'seg-241' } as Segment;

  /** The extraction the builder is expected to emit for a given path. */
  const extract = (path: string) =>
    `JSONExtractString(if(JSONHas(properties, '${path}'), ` +
    `properties, traits), '${path}')`;

  const performed = (properties: unknown[], event = 'contact.label.added') =>
    service.segmentNodeToStateSubQuery(segment, {
      id: 'n1',
      type: SegmentNodeType.Performed,
      event,
      properties,
    } as any)[0].condition;

  const lastPerformed = (
    whereProperties: unknown[],
    event = 'contact.label.added',
  ) =>
    service.segmentNodeToStateSubQuery(segment, {
      id: 'n2',
      type: SegmentNodeType.LastPerformed,
      event,
      whereProperties,
    } as any)[0].condition;

  const prop = (path: string, type: string, value?: string) => ({
    path,
    operator: { type, ...(value === undefined ? {} : { value }) },
  });

  describe('Performed', () => {
    it('falls back to traits for a label filter', () => {
      const condition = performed([prop('labelName', 'Equals', 'VIP')]);

      expect(condition).toContain(`${extract('labelName')} = 'VIP'`);
      // The bug: reading properties alone never matched an identify row.
      expect(condition).not.toContain(
        `JSONExtractString(properties, 'labelName') = 'VIP'`,
      );
    });

    it('falls back to traits for a custom attribute filter', () => {
      const condition = performed(
        [prop('attributeName', 'Equals', 'plano')],
        'contact.custom_attribute.changed',
      );

      expect(condition).toContain(`${extract('attributeName')} = 'plano'`);
    });

    // The negative operators are the dangerous half: on an identify row the old
    // expression compared '' against the value, which was always true — the
    // filter did not filter, and a campaign reached the wrong audience.
    it.each([
      ['NotEquals', `${extract('labelName')} != 'VIP'`],
      ['NotContains', `${extract('labelName')} NOT LIKE '%VIP%'`],
    ])('%s filters instead of passing everyone through', (type, expected) => {
      expect(performed([prop('labelName', type, 'VIP')])).toContain(expected);
    });

    it.each([
      ['Contains', `${extract('labelName')} LIKE '%VIP%'`],
      ['Exists', `${extract('labelName')} != ''`],
      ['NotExists', `${extract('labelName')} = ''`],
    ])('%s uses the same extraction', (type, expected) => {
      expect(performed([prop('labelName', type, 'VIP')])).toContain(expected);
    });

    it.each([
      ['GreaterThan', '>'],
      ['GreaterThanOrEqual', '>='],
      ['LessThan', '<'],
      ['LessThanOrEqual', '<='],
    ])('%s wraps the extraction in toFloat64OrNull', (type, sqlOp) => {
      expect(performed([prop('score', type, '10')])).toContain(
        `toFloat64OrNull(${extract('score')}) ${sqlOp} 10`,
      );
    });

    it('applies the fallback to every property when several are combined', () => {
      const condition = performed([
        prop('labelName', 'Equals', 'VIP'),
        prop('source', 'Equals', 'crm'),
      ]);

      expect(condition).toContain(`${extract('labelName')} = 'VIP'`);
      expect(condition).toContain(`${extract('source')} = 'crm'`);
    });
  });

  describe('LastPerformed', () => {
    it('falls back to traits for a label filter', () => {
      const condition = lastPerformed([prop('labelName', 'Equals', 'VIP')]);

      expect(condition).toContain(`${extract('labelName')} = 'VIP'`);
      expect(condition).not.toContain(
        `JSONExtractString(properties, 'labelName') = 'VIP'`,
      );
    });

    it.each([
      ['NotEquals', `${extract('labelName')} != 'VIP'`],
      ['NotContains', `${extract('labelName')} NOT LIKE '%VIP%'`],
      ['Contains', `${extract('labelName')} LIKE '%VIP%'`],
      ['Exists', `${extract('labelName')} != ''`],
    ])('%s uses the same extraction', (type, expected) => {
      expect(lastPerformed([prop('labelName', type, 'VIP')])).toContain(
        expected,
      );
    });

    // CRM-241: the LastPerformed switch was a smaller copy of the Performed one
    // and did not list these operators — they fell through to `default` and became
    // EQUALITY, with valid SQL and no sign of error. `score > 10` selected
    // score == 10.
    it.each([
      ['GreaterThan', '>'],
      ['GreaterThanOrEqual', '>='],
      ['LessThan', '<'],
      ['LessThanOrEqual', '<='],
    ])('%s really compares, instead of degrading to equality', (type, sqlOp) => {
      const condition = lastPerformed([prop('score', type, '10')]);

      expect(condition).toContain(
        `toFloat64OrNull(${extract('score')}) ${sqlOp} 10`,
      );
      expect(condition).not.toContain(`${extract('score')} = '10'`);
    });

    it('NotExists is handled explicitly, not by the default branch', () => {
      expect(lastPerformed([prop('labelName', 'NotExists')])).toContain(
        `${extract('labelName')} = ''`,
      );
    });
  });

  // The duplicated switch was the root cause of the drift. Now that there is only
  // one, both nodes must emit exactly the same condition for the same property —
  // this block fails if anyone recreates the copy.
  describe('Performed and LastPerformed must not diverge', () => {
    it.each([
      ['Equals'],
      ['NotEquals'],
      ['Contains'],
      ['NotContains'],
      ['Exists'],
      ['NotExists'],
      ['GreaterThan'],
      ['GreaterThanOrEqual'],
      ['LessThan'],
      ['LessThanOrEqual'],
    ])('%s produces the same condition on both nodes', (type) => {
      const p = prop('score', type, '10');
      const doPerformed = performed([p]).replace(
        `event_name = 'contact.label.added' AND `,
        '',
      );
      const doLast = lastPerformed([p]).replace(
        `event_name = 'contact.label.added' AND `,
        '',
      );

      expect(doLast).toBe(doPerformed);
    });
  });

  describe('non-contact events keep reading properties', () => {
    // A track event (campaign/message) fills `properties` and leaves `traits`
    // at `{}`. JSONHas is true there, so the fallback never fires and the SQL
    // is equivalent to what the builder emitted before this fix.
    it('templateId on a WhatsApp node still reads properties directly', () => {
      const condition = service.segmentNodeToStateSubQuery(segment, {
        id: 'n3',
        type: SegmentNodeType.WhatsApp,
        templateId: 'tpl-42',
      } as any)[0].condition;

      expect(condition).toContain(
        `JSONExtractString(properties, 'template_id') = 'tpl-42'`,
      );
      expect(condition).not.toContain('JSONHas(');
    });
  });

  describe('escaping', () => {
    // The escaping moved into the shared helper; make sure it was not dropped on
    // the way. The path is interpolated twice now (JSONHas + JSONExtractString),
    // so a regression here would be two injection points instead of one.
    it('sanitizes a quote in the property path', () => {
      const condition = performed([prop("label'--", 'Equals', 'VIP')]);

      expect(condition).not.toContain(`'label'--'`);
      expect(condition).toContain('JSONHas(');
    });

    it('sanitizes a quote in the value', () => {
      const condition = performed([prop('labelName', 'Equals', "VIP'--")]);

      expect(condition).not.toContain(`= 'VIP'--'`);
    });
  });
});
