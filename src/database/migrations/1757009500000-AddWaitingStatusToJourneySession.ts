import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWaitingStatusToJourneySession1757009500000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log('Adding waiting status to journey_sessions enum');

    try {
      // First, check if the enum type exists
      const enumExists = await queryRunner.query(`
        SELECT 1 FROM pg_type WHERE typname = 'journey_sessions_status_enum';
      `);

      if (enumExists && enumExists.length > 0) {
        // Add 'waiting' to existing enum if it doesn't already exist
        const waitingExists = await queryRunner.query(`
          SELECT 1 FROM pg_enum 
          WHERE enumtypid = (SELECT oid FROM pg_type WHERE typname = 'journey_sessions_status_enum') 
          AND enumlabel = 'waiting';
        `);

        if (!waitingExists || waitingExists.length === 0) {
          await queryRunner.query(`
            ALTER TYPE journey_sessions_status_enum ADD VALUE 'waiting';
          `);
          console.log('✅ Added waiting status to existing enum');
        } else {
          console.log('ℹ️  Waiting status already exists in enum');
        }
      } else {
        console.log('ℹ️  Enum does not exist yet, will be created by entity');
      }

      // Ensure waitingFor column exists (should already exist from entity)
      const columnExists = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='journey_sessions' AND column_name='waiting_for';
      `);

      if (!columnExists || columnExists.length === 0) {
        await queryRunner.query(`
          ALTER TABLE journey_sessions ADD COLUMN waiting_for jsonb;
        `);
        console.log('✅ Added waiting_for column');
      } else {
        console.log('ℹ️  waiting_for column already exists');
      }

      // Ensure variables column exists (should already exist from entity)
      const variablesExists = await queryRunner.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name='journey_sessions' AND column_name='variables';
      `);

      if (!variablesExists || variablesExists.length === 0) {
        await queryRunner.query(`
          ALTER TABLE journey_sessions ADD COLUMN variables jsonb DEFAULT '{}';
        `);
        console.log('✅ Added variables column');
      } else {
        console.log('ℹ️  variables column already exists');
      }

      console.log('✅ Journey sessions enum update completed');
    } catch (error) {
      console.error('❌ Error updating journey sessions enum:', error.message);
      throw error;
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('Rolling back journey sessions enum changes');

    try {
      // Note: PostgreSQL doesn't support removing enum values directly
      // This would require more complex migration with recreating the enum
      console.log(
        '⚠️  Cannot remove enum values in PostgreSQL - manual intervention may be required',
      );
    } catch (error) {
      console.error(
        '❌ Error rolling back journey sessions enum:',
        error.message,
      );
      throw error;
    }
  }
}
