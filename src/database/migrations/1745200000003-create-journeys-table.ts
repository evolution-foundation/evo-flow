import { MigrationInterface, QueryRunner, Table, TableIndex } from 'typeorm';

export class CreateJourneysTable1745200000003 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating journeys table');

    // Create journeys table
    await queryRunner.createTable(
      new Table({
        name: 'journeys',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'name',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'description',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: true,
            isNullable: false,
          },
          {
            name: 'flow_data',
            type: 'jsonb',
            isNullable: false,
            default: "'{}'::jsonb",
          },
          {
            name: 'flow_triggers',
            type: 'jsonb',
            isNullable: false,
            default: "'[]'::jsonb",
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

    // Create indexes
    await queryRunner.createIndex(
      'journeys',
      new TableIndex({
        name: 'IDX_journeys_is_active',
        columnNames: ['is_active'],
      }),
    );

    await queryRunner.createIndex(
      'journeys',
      new TableIndex({
        name: 'IDX_journeys_flow_data',
        columnNames: ['flow_data'],
        isUnique: false,
        isSpatial: false,
        parser: 'gin',
      }),
    );

    await queryRunner.createIndex(
      'journeys',
      new TableIndex({
        name: 'IDX_journeys_flow_triggers',
        columnNames: ['flow_triggers'],
        isUnique: false,
        isSpatial: false,
        parser: 'gin',
      }),
    );

    console.log('✅ Journeys table created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop indexes
    await queryRunner.dropIndex('journeys', 'IDX_journeys_is_active');
    await queryRunner.dropIndex('journeys', 'IDX_journeys_flow_data');
    await queryRunner.dropIndex('journeys', 'IDX_journeys_flow_triggers');

    // Drop table
    await queryRunner.dropTable('journeys');

    console.log('✅ Journeys table dropped successfully');
  }
}
