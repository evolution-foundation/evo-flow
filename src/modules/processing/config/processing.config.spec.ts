import { parseRunMode } from './processing.config';
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
      /Invalid RUN_MODE='batatinha'\. Valid values: single, api, event-worker, segment-worker, temporal-worker, campaign-worker, campaign-packer, campaign-sender, event-receiver, event-process\./,
    );
  });

  it('is case-sensitive (UPPERCASE values are rejected)', () => {
    expect(() => parseRunMode('SINGLE')).toThrow(/Invalid RUN_MODE='SINGLE'/);
  });
});
