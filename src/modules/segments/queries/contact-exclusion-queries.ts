/**
 * Contact exclusion query templates for handling deleted contacts
 * These CASE statements check for contact_deleted events to exclude deleted contacts
 */

export class ContactExclusionQueries {
  /**
   * Generates CASE statement to exclude deleted contacts.
   * @param contactIdAlias - The column reference used for contact_id in the
   *   outer query (e.g., 'c.contact_id', 'ce.contact_id', 'contact_id'). Must
   *   be a bare identifier or qualified identifier — no expressions, no
   *   literals — so it can be safely interpolated into the SQL.
   */
  static getDeletedContactExclusion(contactIdAlias: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(contactIdAlias)) {
      throw new Error(
        `Invalid contactIdAlias: expected a SQL identifier (optionally qualified), got "${contactIdAlias}"`,
      );
    }
    return `
      CASE
        WHEN (
          SELECT COUNT(*)
          FROM evo_campaign.contact_events ce_del
          WHERE ce_del.contact_id = ${contactIdAlias}
            AND ce_del.event_name = 'contact_deleted'
        ) > 0 THEN 0
        ELSE 1
      END = 1`;
  }

  /**
   * Generates argMax subquery to get latest contact state excluding deleted
   */
  static getLatestContactStateExclusion(): string {
    return `
      argMax(
        CASE
          WHEN ce.event_name = 'contact_deleted' THEN 0
          ELSE 1
        END,
        ce.occurred_at
      ) = 1`;
  }

  /**
   * Common WHERE clause for excluding deleted contacts in event-based queries.
   * `contact_id IS NOT NULL` in the subquery is required: a single NULL row
   * makes `NOT IN` evaluate to NULL for every contact and silently empties the
   * outer result.
   */
  static getEventBasedExclusionClause(): string {
    return `
      AND contact_id NOT IN (
        SELECT DISTINCT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'contact_deleted'
          AND contact_id IS NOT NULL
      )`;
  }

  /**
   * Generates exclusion for performed/lastPerformed queries. Same
   * NULL-safety requirement on the NOT IN subquery as
   * getEventBasedExclusionClause.
   */
  static getPerformedEventExclusion(): string {
    return `
      AND ce.contact_id NOT IN (
        SELECT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'contact_deleted'
          AND contact_id IS NOT NULL
      )`;
  }
}
