import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class CreateJourneySessionsTable1756850400001
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating journey_sessions table');

    // Create journey_sessions table
    await queryRunner.createTable(
      new Table({
        name: 'journey_sessions',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'journey_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'contact_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'status',
            type: 'enum',
            enum: ['active', 'completed', 'failed', 'cancelled', 'paused'],
            default: "'active'",
            isNullable: false,
          },
          {
            name: 'current_node_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'context',
            type: 'jsonb',
            isNullable: true,
            default: "'{}'::jsonb",
          },
          {
            name: 'workflow_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'workflow_run_id',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'task_queue',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'started_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'completed_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'failed_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'error_message',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'error_details',
            type: 'jsonb',
            isNullable: true,
          },
          {
            name: 'retry_count',
            type: 'integer',
            default: 0,
            isNullable: false,
          },
          {
            name: 'max_retries',
            type: 'integer',
            default: 3,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
          {
            name: 'updated_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
      true,
    );

    // Create indexes for performance
    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_journey_id',
        columnNames: ['journey_id'],
      }),
    );

    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_contact_id',
        columnNames: ['contact_id'],
      }),
    );

    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_status',
        columnNames: ['status'],
      }),
    );

    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_workflow_id',
        columnNames: ['workflow_id'],
      }),
    );

    // Composite indexes for common queries
    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_journey_contact',
        columnNames: ['journey_id', 'contact_id'],
      }),
    );

    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_journey_status',
        columnNames: ['journey_id', 'status'],
      }),
    );

    // JSONB indexes for context queries
    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_context',
        columnNames: ['context'],
        isUnique: false,
        isSpatial: false,
        parser: 'gin',
      }),
    );

    // Foreign key to journeys table
    await queryRunner.createForeignKey(
      'journey_sessions',
      new TableForeignKey({
        columnNames: ['journey_id'],
        referencedTableName: 'journeys',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        name: 'FK_journey_sessions_journey_id',
      }),
    );

    // Foreign key to contacts table
    await queryRunner.createForeignKey(
      'journey_sessions',
      new TableForeignKey({
        columnNames: ['contact_id'],
        referencedTableName: 'contacts',
        referencedColumnNames: ['id'],
        onDelete: 'CASCADE',
        name: 'FK_journey_sessions_contact_id',
      }),
    );

    console.log('✅ Journey sessions table created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop foreign keys
    await queryRunner.dropForeignKey(
      'journey_sessions',
      'FK_journey_sessions_journey_id',
    );
    await queryRunner.dropForeignKey(
      'journey_sessions',
      'FK_journey_sessions_contact_id',
    );

    // Drop indexes
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_journey_id',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_contact_id',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_status',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_workflow_id',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_journey_contact',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_journey_status',
    );
    await queryRunner.dropIndex(
      'journey_sessions',
      'IDX_journey_sessions_context',
    );

    // Drop table
    await queryRunner.dropTable('journey_sessions');

    console.log('✅ Journey sessions table dropped successfully');
  }
}
