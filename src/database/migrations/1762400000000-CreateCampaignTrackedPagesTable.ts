import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

/**
 * Campaign progress tracking schema (story 4.6 / EVO-1220).
 *
 * `campaign_tracked_pages` is the durable dedup ledger for the broker-native
 * tracking aggregator: one row per (campaign, page). The UNIQUE(campaign_id,
 * page) constraint turns an at-least-once redelivery of `campaigns.tracked`
 * into an idempotent no-op (INSERT … ON CONFLICT DO NOTHING), so the campaign
 * counters never double-count and the completion check counts distinct pages.
 *
 * `campaigns` gains `total_pages` (learned from the page whose `completed=true`
 * signal arrives — sender sets `completed = page === totalPages`) and
 * `failed_contacts` (the aggregate failure counter; `sent_contacts` already
 * exists). Completion = reported distinct pages === total_pages.
 */
export class CreateCampaignTrackedPagesTable1762400000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    await queryRunner.createTable(
      new Table({
        name: 'campaign_tracked_pages',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'campaign_id', type: 'uuid' },
          { name: 'page', type: 'int' },
          { name: 'sent_count', type: 'int', default: '0' },
          { name: 'failed_count', type: 'int', default: '0' },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'campaign_tracked_pages',
      new TableForeignKey({
        columnNames: ['campaign_id'],
        referencedTableName: 'campaigns',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'campaign_tracked_pages',
      new TableIndex({
        name: 'uq_campaign_tracked_pages_campaign_page',
        columnNames: ['campaign_id', 'page'],
        isUnique: true,
      }),
    );

    await queryRunner.addColumns('campaigns', [
      new TableColumn({
        name: 'total_pages',
        type: 'int',
        isNullable: true,
      }),
      new TableColumn({
        name: 'failed_contacts',
        type: 'int',
        default: '0',
      }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('campaigns', 'failed_contacts');
    await queryRunner.dropColumn('campaigns', 'total_pages');
    await queryRunner.dropTable('campaign_tracked_pages', true, true, true);
  }
}
