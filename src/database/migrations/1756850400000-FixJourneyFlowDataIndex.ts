import { MigrationInterface, QueryRunner } from 'typeorm';

export class FixJourneyFlowDataIndex1756850400000
  implements MigrationInterface
{
  public async up(queryRunner: QueryRunner): Promise<void> {
    console.log(
      '🔧 Fixing journey flow_data index - removing B-tree index for large JSONB',
    );

    // Drop the problematic B-tree index
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_journeys_flow_data"`);

    // Create a GIN index instead, which is better for JSONB and doesn't have size limits
    await queryRunner.query(
      `CREATE INDEX "IDX_journeys_flow_data_gin" ON "journeys" USING gin ("flow_data")`,
    );

    console.log('✅ Fixed journey flow_data index successfully');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    console.log('🔧 Reverting journey flow_data index fix');

    // Drop the GIN index
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_journeys_flow_data_gin"`,
    );

    // Recreate the original B-tree index (this will fail for large flow_data, but that's the original state)
    await queryRunner.query(
      `CREATE INDEX "IDX_journeys_flow_data" ON "journeys" ("flow_data")`,
    );

    console.log('✅ Reverted journey flow_data index');
  }
}
