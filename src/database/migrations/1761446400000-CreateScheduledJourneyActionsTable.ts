import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class CreateScheduledJourneyActionsTable1761446400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating scheduled_journey_actions table');

    // Create the table
    await queryRunner.createTable(
      new Table({
        name: 'scheduled_journey_actions',
        columns: [
          new TableColumn({
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          }),
          new TableColumn({
            name: 'journey_id',
            type: 'uuid',
            isNullable: false,
          }),
          new TableColumn({
            name: 'session_id',
            type: 'uuid',
            isNullable: false,
          }),
          new TableColumn({
            name: 'contact_id',
            type: 'uuid',
            isNullable: false,
          }),
          new TableColumn({
            name: 'node_id',
            type: 'varchar',
            isNullable: false,
          }),
          new TableColumn({
            name: 'action_config',
            type: 'jsonb',
            isNullable: false,
            default: "'{}'::jsonb",
          }),
          new TableColumn({
            name: 'scheduled_for',
            type: 'timestamp',
            isNullable: false,
          }),
          new TableColumn({
            name: 'executed_at',
            type: 'timestamp',
            isNullable: true,
          }),
          new TableColumn({
            name: 'status',
            type: 'varchar',
            length: '50',
            isNullable: false,
            default: "'pending'",
          }),
          new TableColumn({
            name: 'error_message',
            type: 'text',
            isNullable: true,
          }),
          new TableColumn({
            name: 'retry_count',
            type: 'integer',
            isNullable: false,
            default: 0,
          }),
          new TableColumn({
            name: 'max_retries',
            type: 'integer',
            isNullable: false,
            default: 3,
          }),
          new TableColumn({
            name: 'scheduled_action_id',
            type: 'bigint',
            isNullable: true,
          }),
          new TableColumn({
            name: 'created_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
          }),
          new TableColumn({
            name: 'updated_at',
            type: 'timestamp',
            isNullable: false,
            default: 'CURRENT_TIMESTAMP',
          }),
        ],
      }),
    );

    // Create indexes
    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_journey_id',
        columnNames: ['journey_id'],
      }),
    );

    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_session_id',
        columnNames: ['session_id'],
      }),
    );

    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_contact_id',
        columnNames: ['contact_id'],
      }),
    );

    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_status',
        columnNames: ['status'],
      }),
    );

    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_scheduled_for',
        columnNames: ['scheduled_for'],
      }),
    );

    await queryRunner.createIndex(
      'scheduled_journey_actions',
      new TableIndex({
        name: 'IDX_scheduled_journey_actions_status_time',
        columnNames: ['status', 'scheduled_for'],
      }),
    );

    console.log('✅ scheduled_journey_actions table created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Dropping scheduled_journey_actions table');

    // Drop all indexes
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_journey_id',
    );
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_session_id',
    );
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_contact_id',
    );
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_status',
    );
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_scheduled_for',
    );
    await queryRunner.dropIndex(
      'scheduled_journey_actions',
      'IDX_scheduled_journey_actions_status_time',
    );

    // Drop table
    await queryRunner.dropTable('scheduled_journey_actions');

    console.log('✅ scheduled_journey_actions table dropped successfully');
  }
}
