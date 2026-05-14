import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddTriggerConfigToCampaigns1762100000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL = queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Adding trigger_config column to campaigns table...');

    // Add trigger_config column
    await queryRunner.addColumn(
      'campaigns',
      new TableColumn({
        name: 'trigger_config',
        type: 'jsonb',
        isNullable: true,
      })
    );

    console.log('✅ trigger_config column added successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('campaigns', 'trigger_config');
  }
}
