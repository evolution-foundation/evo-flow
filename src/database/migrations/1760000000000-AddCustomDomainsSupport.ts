import {
  MigrationInterface,
  QueryRunner,
  Table,
  TableColumn,
  TableIndex,
  TableForeignKey,
} from 'typeorm';

export class AddCustomDomainsSupport1760000000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    console.log('🚀 Creating custom_domains table');

    // Create custom_domains table
    await queryRunner.createTable(
      new Table({
        name: 'custom_domains',
        columns: [
          {
            name: 'id',
            type: 'uuid',
            isPrimary: true,
            generationStrategy: 'uuid',
            default: 'gen_random_uuid()',
          },
          {
            name: 'domain',
            type: 'varchar',
            length: '255',
            isNullable: false,
            isUnique: true,
          },
          {
            name: 'is_verified',
            type: 'boolean',
            default: false,
            isNullable: false,
          },
          {
            name: 'verification_token',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'is_active',
            type: 'boolean',
            default: true,
            isNullable: false,
          },
          {
            name: 'ssl_mode',
            type: 'varchar',
            length: '50',
            default: "'auto'",
            isNullable: false,
          },
          {
            name: 'ssl_certificate',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'ssl_private_key',
            type: 'text',
            isNullable: true,
          },
          {
            name: 'target_cname',
            type: 'varchar',
            length: '255',
            isNullable: true,
          },
          {
            name: 'last_verified_at',
            type: 'timestamp',
            isNullable: true,
          },
          {
            name: 'metadata',
            type: 'jsonb',
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
      true,
    );

    // Create indexes for custom_domains
    await queryRunner.createIndex(
      'custom_domains',
      new TableIndex({
        name: 'IDX_custom_domains_domain',
        columnNames: ['domain'],
        isUnique: true,
      }),
    );

    await queryRunner.createIndex(
      'custom_domains',
      new TableIndex({
        name: 'IDX_custom_domains_is_verified',
        columnNames: ['is_verified'],
      }),
    );

    console.log('✅ custom_domains table created successfully');

    console.log('🚀 Adding custom domain support to short_links table');

    // Add custom_domain_id column
    await queryRunner.addColumn(
      'short_links',
      new TableColumn({
        name: 'custom_domain_id',
        type: 'uuid',
        isNullable: true,
      }),
    );

    // Add custom_slug column
    await queryRunner.addColumn(
      'short_links',
      new TableColumn({
        name: 'custom_slug',
        type: 'varchar',
        length: '100',
        isNullable: true,
      }),
    );

    // Create index for custom_domain_id + custom_slug (unique together)
    await queryRunner.createIndex(
      'short_links',
      new TableIndex({
        name: 'IDX_short_links_custom_domain_slug',
        columnNames: ['custom_domain_id', 'custom_slug'],
        isUnique: true,
        where: 'custom_domain_id IS NOT NULL AND custom_slug IS NOT NULL',
      }),
    );

    // Create foreign key
    await queryRunner.createForeignKey(
      'short_links',
      new TableForeignKey({
        name: 'FK_short_links_custom_domain',
        columnNames: ['custom_domain_id'],
        referencedTableName: 'custom_domains',
        referencedColumnNames: ['id'],
        onDelete: 'SET NULL',
      }),
    );

    console.log('✅ Custom domain support added to short_links table');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Removing custom domain support from short_links table');

    // Drop foreign key
    await queryRunner.dropForeignKey(
      'short_links',
      'FK_short_links_custom_domain',
    );

    // Drop index
    await queryRunner.dropIndex(
      'short_links',
      'IDX_short_links_custom_domain_slug',
    );

    // Drop columns
    await queryRunner.dropColumn('short_links', 'custom_slug');
    await queryRunner.dropColumn('short_links', 'custom_domain_id');

    console.log('✅ Custom domain support removed from short_links table');

    console.log('🔄 Dropping custom_domains table');

    // Drop indexes
    await queryRunner.dropIndex('custom_domains', 'IDX_custom_domains_domain');
    await queryRunner.dropIndex(
      'custom_domains',
      'IDX_custom_domains_is_verified',
    );

    // Drop table
    await queryRunner.dropTable('custom_domains');

    console.log('✅ custom_domains table dropped successfully');
  }
}
