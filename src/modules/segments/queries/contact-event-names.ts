/**
 * Canonical contact event names as emitted by the CRM (`EvoFlow::ContactEventsListener`),
 * plus the legacy underscore spellings older producers used. Query builders must accept
 * both until the central event-name normalization lands (tracked separately); matching a
 * single spelling silently returns zero rows (CRM-215).
 */
export const DELETED_CONTACT_EVENT_NAMES = [
  'contact.deleted',
  'contact_deleted',
] as const;
export const LABEL_ADDED_EVENT_NAMES = [
  'contact.label.added',
  'label_added',
] as const;
export const LABEL_REMOVED_EVENT_NAMES = [
  'contact.label.removed',
  'label_removed',
] as const;

export function sqlStringList(names: readonly string[]): string {
  return names.map((n) => `'${n.replace(/'/g, "''")}'`).join(', ');
}

/**
 * Single source of the "deleted contacts" subselect. Every CASE in the segment SQL builder
 * and the deleted-contacts cache embed this exact text, and
 * `SegmentQueryExecutionService` rewrites it by regex — keep it one line so the match is stable.
 */
export const DELETED_CONTACTS_SUBQUERY =
  `SELECT DISTINCT contact_or_anonymous_id FROM contact_events ` +
  `WHERE event_name IN (${sqlStringList(DELETED_CONTACT_EVENT_NAMES)}) ` +
  `GROUP BY contact_or_anonymous_id HAVING argMax(occurred_at, occurred_at) > 0`;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches the deleted-contacts CASE branch the builder emits, whitespace-tolerant.
 * Group 1 is the branch's result literal, which differs per node type and must be
 * preserved by any rewrite (see `applyDeletedContactsOptimization`).
 * A fresh instance per call: a shared /g regex carries `lastIndex` between callers.
 */
export function deletedContactsCaseBranchRegex(): RegExp {
  return new RegExp(
    `WHEN contact_or_anonymous_id IN \\(\\s*${escapeRegExp(DELETED_CONTACTS_SUBQUERY)}\\s*\\) THEN '([^']*)'`,
    'g',
  );
}

/**
 * In-process signal emitted by the events API when a deleted-contact event is ingested,
 * so the deleted-contacts cache drops its snapshot before the next segment recompute.
 * Without it the incremental recompute could evaluate the deletion window with a stale
 * (empty) cache and keep the contact assigned until a full recompute (CRM-215).
 */
export const CONTACT_DELETED_INGESTED_EVENT =
  'segments.contact-deleted.ingested';

/**
 * Replaces the deleted-contacts subselect in a state query with the cached id list.
 * It is an optimization only: with an EMPTY cache the real subselect is kept, because
 * "no deleted contacts cached" is not the same as "no deleted contacts".
 */
export function applyDeletedContactsOptimization(
  query: string,
  deletedContacts: ReadonlySet<string>,
): string {
  if (deletedContacts.size === 0) return query;
  const list = Array.from(deletedContacts)
    .map((id) => `'${id.replace(/'/g, "''")}'`)
    .join(',');
  // Keep the branch's own result literal: most node types mark a deleted contact with the
  // empty sentinel, and membership is `argMaxMerge(last_value) != ''` — rewriting it to a
  // non-empty literal puts the contact back in the segment. A replacer function is used so
  // `$` inside an id is not read as a capture reference.
  return query.replace(
    deletedContactsCaseBranchRegex(),
    (_match, sentinel: string) =>
      `WHEN contact_or_anonymous_id IN (${list}) THEN '${sentinel}'`,
  );
}
