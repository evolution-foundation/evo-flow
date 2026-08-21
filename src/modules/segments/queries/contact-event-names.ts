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
  return names.map((n) => `'${n}'`).join(', ');
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

/** Matches the deleted-contacts CASE branch the builder emits, whitespace-tolerant. */
export const DELETED_CONTACTS_CASE_BRANCH_REGEX = new RegExp(
  `WHEN contact_or_anonymous_id IN \\(\\s*${escapeRegExp(DELETED_CONTACTS_SUBQUERY)}\\s*\\) THEN '[^']*'`,
  'g',
);
