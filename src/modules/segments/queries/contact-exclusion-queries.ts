/**
 * Contact exclusion query templates for handling deleted contacts
 * These CASE statements check for contact_deleted events to exclude deleted contacts
 */

export class ContactExclusionQueries {
  /**
   * Generates CASE statement to exclude deleted contacts
   * @param contactIdAlias - The alias used for contact_id in the query (e.g., 'c.contact_id', 'contact_id')
   */
  static getDeletedContactExclusion(contactIdAlias: string): string {
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
        ce.created_at
      ) = 1`;
  }

  /**
   * Common WHERE clause for excluding deleted contacts in event-based queries
   */
  static getEventBasedExclusionClause(): string {
    return `
      AND contact_id NOT IN (
        SELECT DISTINCT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'contact_deleted'
      )`;
  }

  /**
   * Generates exclusion for performed/lastPerformed queries
   */
  static getPerformedEventExclusion(): string {
    return `
      AND ce.contact_id NOT IN (
        SELECT contact_id
        FROM evo_campaign.contact_events
        WHERE event_name = 'contact_deleted'
      )`;
  }
}
