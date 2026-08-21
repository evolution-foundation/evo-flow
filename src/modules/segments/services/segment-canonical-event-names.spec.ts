import { SegmentClickHouseQueryBuilderService } from './segment-clickhouse-query-builder.service';
import { SegmentNodeType } from '../entities/segment.entity';
import {
  DELETED_CONTACTS_CASE_BRANCH_REGEX,
  DELETED_CONTACTS_SUBQUERY,
} from '../queries/contact-event-names';

/**
 * CRM-215 — the CRM emits dotted canonical event names (`contact.label.added`,
 * `contact.deleted`) with the label id in `traits`; the builder filtered the legacy
 * underscore spelling and read `properties`, so Label segments computed 0 members and
 * deleted contacts were never excluded. Both spellings are accepted until the central
 * normalization lands.
 */
describe('CRM-215 segment SQL matches the canonical contact event names', () => {
  const builder = new SegmentClickHouseQueryBuilderService();
  const segment = { id: 'seg-1' } as any;

  it('Label has: filters both label spellings and reads labelId from traits', () => {
    const node = {
      id: 'n1',
      type: SegmentNodeType.Label,
      labelId: 'lbl-1',
      condition: 'has',
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.condition).toContain("'contact.label.added'");
    expect(subQuery.condition).toContain("'contact.label.removed'");
    expect(subQuery.condition).toContain("'label_added'");
    expect(subQuery.condition).toContain(
      "JSONExtractString(traits, 'labelId') = 'lbl-1'",
    );
    expect(subQuery.condition).not.toContain(
      "JSONExtractString(properties, 'labelId')",
    );
    expect(subQuery.argMaxValue).toContain(
      "if(event_name IN ('contact.label.added', 'label_added'), 'true', 'false')",
    );
  });

  it('Label not_has: the exclusion subselect uses the same canonical names and traits', () => {
    const node = {
      id: 'n1',
      type: SegmentNodeType.Label,
      labelId: 'lbl-1',
      condition: 'not_has',
    } as any;

    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    expect(subQuery.argMaxValue).toContain("'contact.label.added'");
    expect(subQuery.argMaxValue).toContain(
      "JSONExtractString(traits, 'labelId') = 'lbl-1'",
    );
    expect(subQuery.argMaxValue).not.toContain('properties');
    expect(subQuery.argMaxValue).toContain(
      "HAVING argMax(if(event_name IN ('contact.label.added', 'label_added'), 'true', 'false'), occurred_at) = 'true'",
    );
  });

  it('every deleted-contacts guard matches contact.deleted (and the legacy spelling)', () => {
    const nodes = [
      {
        id: 'n2',
        type: SegmentNodeType.Label,
        labelId: 'lbl-1',
        condition: 'has',
      },
      {
        id: 'n3',
        type: SegmentNodeType.Label,
        labelId: 'lbl-1',
        condition: 'not_has',
      },
      {
        id: 'n4',
        type: SegmentNodeType.UserProperty,
        path: 'customAttributes.tier',
        operator: { type: 'Equals', value: 'x' },
        value: 'x',
      },
    ] as any[];

    for (const node of nodes) {
      const serialized = JSON.stringify(
        builder.segmentNodeToStateSubQuery(segment, node),
      );
      expect(serialized).toContain(
        "event_name IN ('contact.deleted', 'contact_deleted')",
      );
      expect(serialized).not.toContain("event_name = 'contact_deleted'");
    }
  });

  it('the execution-time rewrite still recognizes the deleted-contacts CASE branch', () => {
    const node = {
      id: 'n1',
      type: SegmentNodeType.Label,
      labelId: 'lbl-1',
      condition: 'has',
    } as any;
    const [subQuery] = builder.segmentNodeToStateSubQuery(segment, node);

    const rewritten = String(subQuery.argMaxValue).replace(
      DELETED_CONTACTS_CASE_BRANCH_REGEX,
      `WHEN 1=0 THEN 'false'`,
    );

    expect(rewritten).toContain(`WHEN 1=0 THEN 'false'`);
    expect(rewritten).not.toContain(DELETED_CONTACTS_SUBQUERY);
  });
});
