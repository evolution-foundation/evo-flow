import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableForeignKey,
  TableIndex,
} from 'typeorm';

export class CreateClickTrackingTables1757100000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating click tracking tables (short_links, link_parameters)');

    // 1. Create short_links table
    await queryRunner.createTable(
      new Table({
        name: 'short_links',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'short_code',
            type: 'varchar',
            length: '10',
            isUnique: true,
            isNullable: false,
          },
          {
            name: 'original_url',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'campaign_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'journey_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'contact_id',
            type: 'uuid',
            isNullable: true,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: true,
            isNullable: false,
          },
          {
            name: 'click_count',
            type: 'integer',
            default: 0,
            isNullable: false,
          },
          {
            name: 'expires_at',
            type: 'timestamp',
            isNullable: true,
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
      true, // ifNotExists
    );

    // Create indexes for short_links
    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_short_code',
        columnNames: ['short_code'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_campaign_id',
        columnNames: ['campaign_id'],
      }),
    );

    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_journey_id',
        columnNames: ['journey_id'],
      }),
    );

    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_contact_id',
        columnNames: ['contact_id'],
      }),
    );

    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_is_active',
        columnNames: ['is_active'],
      }),
    );

    console.log('✅ short_links table created with indexes');

    // 2. Create link_parameters table
    await queryRunner.createTable(
      new Table({
        name: 'link_parameters',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            default: 'uuid_generate_v4()',
          },
          {
            name: 'short_link_id',
            type: 'uuid',
            isNullable: false,
          },
          {
            name: 'key',
            type: 'varchar',
            length: '255',
            isNullable: false,
          },
          {
            name: 'value',
            type: 'text',
            isNullable: false,
          },
          {
            name: 'is_utm',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'created_at',
            type: 'timestamp',
            default: 'CURRENT_TIMESTAMP',
            isNullable: false,
          },
        ],
      }),
      true, // ifNotExists
    );

    // Create index for link_parameters
    await queryRunner.createIndex(
      'link_parameters',
      new TableIndex({
        name: 'IDX_link_parameters_short_link_id',
        columnNames: ['short_link_id'],
      }),
    );

    console.log('✅ link_parameters table created with index');

    // 3. Create foreign key from link_parameters to short_links
    await queryRunner.createForeignKey(
      'link_parameters',
      new TableForeignKey({
        name: 'FK_link_parameters_short_link',
        columnNames: ['short_link_id'],
        referencedColumnNames: ['id'],
        referencedTableName: 'short_links',
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      }),
    );

    console.log('✅ Foreign key created from link_parameters to short_links');

    // 4. Create foreign keys to other tables (if they exist)
    // Foreign key to contacts (if exists)
    const contactsTableExists = await queryRunner.hasTable('contacts');
    if (contactsTableExists) {
      await queryRunner.createForeignKey(
        'short_links',
        new TableForeignKey({
          name: 'FK_short_links_contact',
          columnNames: ['contact_id'],
          referencedColumnNames: ['id'],
          referencedTableName: 'contacts',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        }),
      );
      console.log('✅ Foreign key created from short_links to contacts');
    }

    // Foreign key to campaigns (if exists)
    const campaignsTableExists = await queryRunner.hasTable('campaigns');
    if (campaignsTableExists) {
      await queryRunner.createForeignKey(
        'short_links',
        new TableForeignKey({
          name: 'FK_short_links_campaign',
          columnNames: ['campaign_id'],
          referencedColumnNames: ['id'],
          referencedTableName: 'campaigns',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        }),
      );
      console.log('✅ Foreign key created from short_links to campaigns');
    }

    // Foreign key to journeys (if exists)
    const journeysTableExists = await queryRunner.hasTable('journeys');
    if (journeysTableExists) {
      await queryRunner.createForeignKey(
        'short_links',
        new TableForeignKey({
          name: 'FK_short_links_journey',
          columnNames: ['journey_id'],
          referencedColumnNames: ['id'],
          referencedTableName: 'journeys',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        }),
      );
      console.log('✅ Foreign key created from short_links to journeys');
    }

    console.log('✅ Click tracking tables created successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Dropping click tracking tables');

    // Drop foreign keys first
    const linkParametersTable = await queryRunner.getTable('link_parameters');
    if (linkParametersTable) {
      const foreignKey = linkParametersTable.foreignKeys.find(
        (fk) => fk.name === 'FK_link_parameters_short_link',
      );
      if (foreignKey) {
        await queryRunner.dropForeignKey('link_parameters', foreignKey);
      }
    }

    const shortLinksTable = await queryRunner.getTable('short_links');
    if (shortLinksTable) {
      const foreignKeys = ['FK_short_links_contact', 'FK_short_links_campaign', 'FK_short_links_journey'];
      for (const fkName of foreignKeys) {
        const foreignKey = shortLinksTable.foreignKeys.find(
          (fk) => fk.name === fkName,
        );
        if (foreignKey) {
          await queryRunner.dropForeignKey('short_links', foreignKey);
        }
      }
    }

    // Drop tables
    await queryRunner.dropTable('link_parameters', true);
    await queryRunner.dropTable('short_links', true);

    console.log('✅ Click tracking tables dropped successfully');
  }
}
