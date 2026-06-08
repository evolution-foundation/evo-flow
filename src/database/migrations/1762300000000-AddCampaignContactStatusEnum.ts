import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCampaignContactStatusEnum1762300000000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    // Normalize any pre-existing lowercase values to match the enum casing.
    await queryRunner.query(`
      UPDATE campaigns_contacts SET status = UPPER(status) WHERE status IS NOT NULL;
    `);

    // Backfill NULLs to PENDING so the column can carry a NOT NULL invariant.
    await queryRunner.query(`
      UPDATE campaigns_contacts SET status = 'PENDING' WHERE status IS NULL;
    `);

    await queryRunner.query(`
      CREATE TYPE campaign_contact_status_enum AS ENUM ('PENDING', 'SENT', 'FAILED', 'SKIPPED');
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts ALTER COLUMN status DROP DEFAULT;
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts
      ALTER COLUMN status TYPE campaign_contact_status_enum
      USING status::campaign_contact_status_enum;
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts ALTER COLUMN status SET DEFAULT 'PENDING';
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts ALTER COLUMN status SET NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const isPostgreSQL =
      queryRunner.connection.driver.options.type === 'postgres';

    if (!isPostgreSQL) {
      throw new Error('This migration only supports PostgreSQL.');
    }

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts ALTER COLUMN status DROP NOT NULL;
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts ALTER COLUMN status DROP DEFAULT;
    `);

    await queryRunner.query(`
      ALTER TABLE campaigns_contacts
      ALTER COLUMN status TYPE varchar(50)
      USING status::text;
    `);

    await queryRunner.query(`
      DROP TYPE campaign_contact_status_enum;
    `);
  }
}
