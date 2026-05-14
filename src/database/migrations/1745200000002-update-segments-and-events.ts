import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateSegmentsAndEvents1745200000002
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log(
      '🚀 Updating segments and contact_events tables for computation engine',
    );

    // Add missing fields to segments table
    const segmentsExists = await queryRunner.hasTable('segments');
    if (segmentsExists) {
      console.log('🔧 Adding new fields to segments table...');

      // Check if fields already exist before adding them
      const segmentsTable = await queryRunner.getTable('segments');

      if (!segmentsTable?.findColumnByName('contacts_count')) {
        await queryRunner.query(`
          ALTER TABLE segments 
          ADD COLUMN contacts_count INTEGER DEFAULT 0 NOT NULL
        `);
      }

      if (!segmentsTable?.findColumnByName('version')) {
        await queryRunner.query(`
          ALTER TABLE segments 
          ADD COLUMN version INTEGER DEFAULT 1 NOT NULL
        `);
      }

      console.log('✅ Segments table updated');
    }

    console.log('✅ Segments update migration completed');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('⚠️ Rolling back segments updates...');

    // Remove added fields from segments table
    try {
      await queryRunner.query(
        'ALTER TABLE segments DROP COLUMN IF EXISTS contacts_count',
      );
      await queryRunner.query(
        'ALTER TABLE segments DROP COLUMN IF EXISTS version',
      );
    } catch (error) {
      console.log('⚠️ Could not remove segments fields during rollback');
    }

    console.log('✅ Rollback completed');
  }
}
