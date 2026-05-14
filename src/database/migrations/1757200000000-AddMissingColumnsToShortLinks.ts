import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

export class AddMissingColumnsToShortLinks1757200000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log('🚀 Adding missing columns to short_links table');

    const table = await queryRunner.getTable('short_links');
    if (!table) {
      console.log('⚠️ short_links table not found, skipping migration');
      return;
    }

    // Check and add title column
    const titleColumn = table.findColumnByName('title');
    if (!titleColumn) {
      await queryRunner.addColumn(
        'short_links',
        new TableColumn({
          name: 'title',
          type: 'text',
          isNullable: true,
        }),
      );
      console.log('✅ Added title column');
    }

    // Check and add description column
    const descriptionColumn = table.findColumnByName('description');
    if (!descriptionColumn) {
      await queryRunner.addColumn(
        'short_links',
        new TableColumn({
          name: 'description',
          type: 'text',
          isNullable: true,
        }),
      );
      console.log('✅ Added description column');
    }

    // Check and add metadata column
    const metadataColumn = table.findColumnByName('metadata');
    if (!metadataColumn) {
      await queryRunner.addColumn(
        'short_links',
        new TableColumn({
          name: 'metadata',
          type: 'json',
          isNullable: true,
        }),
      );
      console.log('✅ Added metadata column');
    }

    // Check and add unique_click_count column
    const uniqueClickCountColumn = table.findColumnByName('unique_click_count');
    if (!uniqueClickCountColumn) {
      await queryRunner.addColumn(
        'short_links',
        new TableColumn({
          name: 'unique_click_count',
          type: 'integer',
          default: 0,
          isNullable: false,
        }),
      );
      console.log('✅ Added unique_click_count column');
    }

    console.log('✅ Missing columns added successfully to short_links table');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔄 Removing columns from short_links table');

    const table = await queryRunner.getTable('short_links');
    if (!table) {
      console.log('⚠️ short_links table not found, skipping migration rollback');
      return;
    }

    // Drop columns if they exist
    if (table.findColumnByName('unique_click_count')) {
      await queryRunner.dropColumn('short_links', 'unique_click_count');
    }

    if (table.findColumnByName('metadata')) {
      await queryRunner.dropColumn('short_links', 'metadata');
    }

    if (table.findColumnByName('description')) {
      await queryRunner.dropColumn('short_links', 'description');
    }

    if (table.findColumnByName('title')) {
      await queryRunner.dropColumn('short_links', 'title');
    }

    console.log('✅ Columns removed successfully from short_links table');
  }
}
