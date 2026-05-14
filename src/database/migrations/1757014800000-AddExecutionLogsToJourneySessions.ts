import { MigrationInterface, QueryRunner, TableColumn, TableIndex } from 'typeorm';

export class AddExecutionLogsToJourneySessions1757014800000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Adding execution_logs column to journey_sessions table');

    // Add execution_logs column to journey_sessions table
    await queryRunner.addColumn(
      'journey_sessions',
      new TableColumn({
        name: 'execution_logs',
        type: 'jsonb',
        isNullable: false,
        default: "'[]'::jsonb",
      }),
    );

    // Create index for execution_logs column (GIN index for JSONB)
    await queryRunner.createIndex(
      'journey_sessions',
      new TableIndex({
        name: 'IDX_journey_sessions_execution_logs',
        columnNames: ['execution_logs'],
        isUnique: false,
        isSpatial: false,
        parser: 'gin',
      }),
    );

    console.log('✅ Execution logs column added successfully to journey_sessions table');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Removing execution_logs column from journey_sessions table');

    // Drop index
    await queryRunner.dropIndex('journey_sessions', 'IDX_journey_sessions_execution_logs');

    // Drop column
    await queryRunner.dropColumn('journey_sessions', 'execution_logs');

    console.log('✅ Execution logs column removed successfully from journey_sessions table');
  }
}