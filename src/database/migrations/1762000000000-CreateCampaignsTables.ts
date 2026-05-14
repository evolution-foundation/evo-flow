import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class CreateCampaignsTables1762000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating campaigns tables...');

    // 1. campaigns
    await this.createCampaignsTable(queryRunner);

    // 2. campaigns_templates
    await this.createCampaignTemplatesTable(queryRunner);

    // 3. campaigns_contacts
    await this.createCampaignContactsTable(queryRunner);

    // 4. campaigns_configs
    await this.createCampaignConfigsTable(queryRunner);

    console.log('✅ Campaigns tables created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropTable('campaigns_contacts', true, true, true);
    await queryRunner.dropTable('campaigns_templates', true, true, true);
    await queryRunner.dropTable('campaigns_configs', true, true, true);
    await queryRunner.dropTable('campaigns', true, true, true);
  }

  private async createCampaignsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'campaigns',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'gen_random_uuid()',
          },
          { name: 'title', type: 'varchar', length: '255', isNullable: false },
          { name: 'name', type: 'varchar', length: '40', isNullable: false },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'publisher', type: 'varchar', length: '100', isNullable: true },
          { name: 'schedule_to', type: 'timestamptz', isNullable: true },
          { name: 'scheduled_job_id', type: 'varchar', length: '255', isNullable: true },
          { name: 'status', type: 'integer', default: 0, isNullable: false },
          { name: 'spread_sending', type: 'integer', isNullable: true },
          { name: 'sent_contacts', type: 'decimal', isNullable: true },
          { name: 'sent_percentage', type: 'decimal', isNullable: true },
          { name: 'query', type: 'text', isNullable: true },
          { name: 'steps', type: 'jsonb', isNullable: true },
          { name: 'tags', type: 'jsonb', isNullable: true },
          { name: 'send_to_all', type: 'boolean', default: false },
          { name: 'type', type: 'varchar', length: '30', isNullable: false },
          { name: 'inbox_id', type: 'uuid', isNullable: true },
          { name: 'channel_type', type: 'varchar', length: '50', isNullable: true },
          { name: 'is_rate_limit', type: 'boolean', default: false },
          { name: 'is_run_segment', type: 'boolean', default: false },
          { name: 'recurrence_count', type: 'integer', default: 0 },
          { name: 'recurrence_settings', type: 'jsonb', isNullable: true },
          { name: 'testab_name', type: 'varchar', length: '255', isNullable: true },
          { name: 'testab_subject', type: 'varchar', length: '255', isNullable: true },
          { name: 'testab_percentage', type: 'decimal', isNullable: true },
          { name: 'testab_winner_criteria', type: 'varchar', length: '50', isNullable: true },
          { name: 'testab_duration_hours', type: 'integer', isNullable: true },
          { name: 'phone_number_strategy', type: 'varchar', length: '50', default: "'round_robin'" },
          { name: 'template_allocation_config', type: 'jsonb', default: "'{}'" },
          { name: 'delivery_distribution', type: 'jsonb', default: "'{}'" },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          { name: 'updated_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          { name: 'deleted_at', type: 'timestamp', isNullable: true },
        ],
      }),
      true,
    );

    // Indexes
    await queryRunner.createIndex(
      'campaigns',
      new TableIndex({ name: 'idx_campaigns_status', columnNames: ['status'] }),
    );
    await queryRunner.createIndex(
      'campaigns',
      new TableIndex({ name: 'idx_campaigns_inbox_id', columnNames: ['inbox_id'] }),
    );
    await queryRunner.createIndex(
      'campaigns',
      new TableIndex({ name: 'idx_campaigns_channel_type', columnNames: ['channel_type'] }),
    );
    await queryRunner.query(`
      CREATE INDEX idx_campaigns_schedule_to ON campaigns(schedule_to) WHERE status = 1;
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX unique_campaign_name ON campaigns(name);
    `);
  }

  private async createCampaignTemplatesTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'campaigns_templates',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'campaign_id', type: 'uuid', isNullable: false },
          { name: 'message_template_id', type: 'uuid', isNullable: false },
          { name: 'variant', type: 'varchar', length: '10', default: "'A'" },
          { name: 'is_winner', type: 'boolean', default: false },
          { name: 'statistics', type: 'jsonb', default: "'{}'" },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          { name: 'updated_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
      true,
    );

    // Foreign Key for campaign
    await queryRunner.createForeignKey(
      'campaigns_templates',
      new TableForeignKey({
        columnNames: ['campaign_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'campaigns',
        onDelete: 'CASCADE',
      }),
    );

    // Indexes
    await queryRunner.createIndex(
      'campaigns_templates',
      new TableIndex({ name: 'idx_campaign_templates_campaign_id', columnNames: ['campaign_id'] }),
    );
    await queryRunner.createIndex(
      'campaigns_templates',
      new TableIndex({ name: 'idx_campaign_templates_message_template_id', columnNames: ['message_template_id'] }),
    );
    await queryRunner.query(`
      CREATE UNIQUE INDEX unique_campaign_template_variant
      ON campaigns_templates(campaign_id, message_template_id, variant);
    `);
  }


  private async createCampaignContactsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'campaigns_contacts',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'campaign_id', type: 'uuid', isNullable: false },
          { name: 'contact_id', type: 'uuid', isNullable: false },
          { name: 'sent_at', type: 'timestamp', isNullable: true },
          { name: 'status', type: 'varchar', length: '50', isNullable: true },
          { name: 'batch_sequence', type: 'integer', isNullable: true },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
      true,
    );

    // Foreign Keys
    await queryRunner.createForeignKey(
      'campaigns_contacts',
      new TableForeignKey({
        columnNames: ['campaign_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'campaigns',
        onDelete: 'CASCADE',
      }),
    );
    await queryRunner.createForeignKey(
      'campaigns_contacts',
      new TableForeignKey({
        columnNames: ['contact_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'contacts',
        onDelete: 'CASCADE',
      }),
    );

    // Indexes
    await queryRunner.createIndex(
      'campaigns_contacts',
      new TableIndex({ name: 'idx_campaign_contacts_campaign_id', columnNames: ['campaign_id'] }),
    );
    await queryRunner.createIndex(
      'campaigns_contacts',
      new TableIndex({ name: 'idx_campaign_contacts_contact_id', columnNames: ['contact_id'] }),
    );
    await queryRunner.createIndex(
      'campaigns_contacts',
      new TableIndex({ name: 'idx_campaign_contacts_cursor', columnNames: ['campaign_id', 'created_at', 'id'] }),
    );
    await queryRunner.query(`
      CREATE INDEX idx_campaign_contacts_batch_sequence
      ON campaigns_contacts(campaign_id, batch_sequence)
      WHERE batch_sequence IS NOT NULL;
    `);
  }

  private async createCampaignConfigsTable(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.createTable(
      new Table({
        name: 'campaigns_configs',
        columns: [
          { name: 'id', type: 'uuid', isPrimary: true, default: 'gen_random_uuid()' },
          { name: 'name', type: 'varchar', length: '255', isNullable: false },
          { name: 'description', type: 'text', isNullable: true },
          { name: 'configs', type: 'jsonb', isNullable: false, default: "'{}'" },
          { name: 'created_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
          { name: 'updated_at', type: 'timestamp', default: 'CURRENT_TIMESTAMP' },
        ],
      }),
      true,
    );

    await queryRunner.query(`
      CREATE INDEX idx_campaign_configs_configs ON campaigns_configs USING GIN (configs);
    `);
  }
}
