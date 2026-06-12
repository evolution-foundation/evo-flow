import { parseRunMode, getProcessingConfig } from './processing.config';
import { RunMode } from '../enums/run-mode.enum';

describe('parseRunMode', () => {
  it('returns SINGLE when RUN_MODE is undefined (env var unset)', () => {
    expect(parseRunMode(undefined)).toBe(RunMode.SINGLE);
  });

  it('throws when RUN_MODE is an empty string (caught misconfiguration)', () => {
    expect(() => parseRunMode('')).toThrow(/empty string/i);
  });

  it('accepts every value declared on the RunMode enum', () => {
    for (const value of Object.values(RunMode)) {
      expect(parseRunMode(value)).toBe(value);
    }
  });

  it('throws on unknown values with the full list of valid options', () => {
    expect(() => parseRunMode('batatinha')).toThrow(
      /Invalid RUN_MODE='batatinha'\. Valid values: single, api, event-worker, segment-worker, temporal-worker, campaign-worker, campaign-packer, campaign-sender, campaign-tracker, event-receiver, event-process\./,
    );
  });

  it('is case-sensitive (UPPERCASE values are rejected)', () => {
    expect(() => parseRunMode('SINGLE')).toThrow(/Invalid RUN_MODE='SINGLE'/);
  });
});

describe('getProcessingConfig — Kafka topic compression (EVO-1727)', () => {
  const KEY = 'KAFKA_TOPIC_COMPRESSION_TYPE';
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });

  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to gzip — kafkajs decodes gzip natively; zstd crashes the consumer', () => {
    expect(getProcessingConfig().kafka?.topicConfig?.compressionType).toBe(
      'gzip',
    );
  });

  it('default is never a codec-requiring compression (zstd/snappy) without a registered codec', () => {
    const value = getProcessingConfig().kafka?.topicConfig?.compressionType;
    expect(['zstd', 'snappy']).not.toContain(value);
  });
});
