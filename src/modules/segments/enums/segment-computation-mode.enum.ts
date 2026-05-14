/**
 * Modos de computação de segmentos
 *
 * - postgres: Computação direta no PostgreSQL (simples, eficiente)
 * - clickhouse: Pipeline ClickHouse (escalável, mas mais complexo)
 */
export enum SegmentComputationMode {
  POSTGRES = 'postgres',
  CLICKHOUSE = 'clickhouse',
}

export function getSegmentComputationMode(): SegmentComputationMode {
  const mode = process.env.SEGMENT_COMPUTATION_MODE?.toLowerCase();

  switch (mode) {
    case 'clickhouse':
      return SegmentComputationMode.CLICKHOUSE;
    case 'postgres':
    default:
      return SegmentComputationMode.POSTGRES;
  }
}
