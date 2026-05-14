import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddVariablesToJourneys1757013207000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Adding variables column to journeys table');

    // Add variables column to journeys table
    await queryRunner.addColumn(
      'journeys',
      new TableColumn({
        name: 'variables',
        type: 'jsonb',
        isNullable: false,
        default: "'[]'::jsonb",
      }),
    );

    // Create index for variables column (GIN index for JSONB)
    await queryRunner.createIndex(
      'journeys',
      new TableIndex({
        name: 'IDX_journeys_variables',
        columnNames: ['variables'],
        isUnique: false,
        isSpatial: false,
        parser: 'gin',
      }),
    );

    console.log('✅ Variables column added successfully to journeys table');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Removing variables column from journeys table');

    // Drop index
    await queryRunner.dropIndex('journeys', 'IDX_journeys_variables');

    // Drop column
    await queryRunner.dropColumn('journeys', 'variables');

    console.log('✅ Variables column removed successfully from journeys table');
  }
}
