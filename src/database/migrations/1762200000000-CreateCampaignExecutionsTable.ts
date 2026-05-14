import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateCampaignExecutionsTable1762200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL = queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    await queryRunner.createTable(
      new Table({
        name: 'campaign_executions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'campaign_id', type: 'uuid' },
          { name: 'workflow_id', type: 'varchar', length: '255' },
          { name: 'run_id', type: 'varchar', length: '255' },
          {
            name: 'status',
            type: 'varchar',
            length: '20',
            default: "'running'",
          },
          { name: 'total_contacts', type: 'int', default: '0' },
          { name: 'processed_contacts', type: 'int', default: '0' },
          { name: 'sent_contacts', type: 'int', default: '0' },
          { name: 'failed_contacts', type: 'int', default: '0' },
          { name: 'current_batch', type: 'int', default: '0' },
          { name: 'total_batches', type: 'int', default: '0' },
          {
            name: 'started_at',
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
          { name: 'ended_at', type: 'timestamptz', isNullable: true },
          { name: 'last_error', type: 'text', isNullable: true },
          { name: 'metadata', type: 'jsonb', default: "'{}'" },
          {
            name: 'created_at',
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
          {
            name: 'updated_at',
            type: 'timestamptz',
            default: 'CURRENT_TIMESTAMP',
          },
        ],
      }),
      true,
    );

    await queryRunner.createForeignKey(
      'campaign_executions',
      new TableForeignKey({
        columnNames: ['campaign_id'],
        referencedTableName: 'campaigns',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
      }),
    );

    await queryRunner.createIndex(
      'campaign_executions',
      new TableIndex({
        name: 'idx_campaign_executions_campaign_id',
        columnNames: ['campaign_id'],
      }),
    );

    await queryRunner.createIndex(
      'campaign_executions',
      new TableIndex({
        name: 'idx_campaign_executions_campaign_status',
        columnNames: ['campaign_id', 'status'],
      }),
    );

    await queryRunner.createIndex(
      'campaign_executions',
      new TableIndex({
        name: 'idx_campaign_executions_workflow_id',
        columnNames: ['workflow_id'],
      }),
    );

    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION update_updated_at_column()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX uq_campaign_executions_active_per_campaign
      ON campaign_executions(campaign_id)
      WHERE status IN ('running', 'paused')
    `);

    await queryRunner.query(`
      CREATE TRIGGER update_campaign_executions_updated_at
      BEFORE UPDATE ON campaign_executions
      FOR EACH ROW
      EXECUTE FUNCTION update_updated_at_column();
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP TRIGGER IF EXISTS update_campaign_executions_updated_at ON campaign_executions',
    );
    await queryRunner.query(
      'DROP INDEX IF EXISTS uq_campaign_executions_active_per_campaign',
    );
    await queryRunner.dropTable('campaign_executions', true, true, true);
  }
}
