import {
  extractSqlState,
  isDeterministicDbError,
} from './deterministic-db-error';

describe('extractSqlState', () => {
  it('reads a top-level driver `code`', () => {
    expect(extractSqlState({ code: '42601' })).toBe('42601');
  });

  it('reads a TypeORM QueryFailedError nested `driverError.code`', () => {
    expect(extractSqlState({ driverError: { code: '22P02' } })).toBe('22P02');
  });

  it('returns undefined for non-objects, missing or malformed codes', () => {
    expect(extractSqlState(null)).toBeUndefined();
    expect(extractSqlState('boom')).toBeUndefined();
    expect(extractSqlState(new Error('no code'))).toBeUndefined();
    expect(extractSqlState({ code: 'nope' })).toBeUndefined();
  });
});

describe('isDeterministicDbError', () => {
  it.each([
    ['42601', 'syntax error'],
    ['42P01', 'undefined table'],
    ['42703', 'undefined column'],
    ['22P02', 'invalid text representation'],
  ])('classifies SQLSTATE %s (%s) as deterministic', (code) => {
    expect(isDeterministicDbError({ code })).toBe(true);
  });

  it.each([
    ['08006', 'connection failure'],
    ['53300', 'too many connections'],
    ['57P03', 'cannot connect now'],
    ['40P01', 'deadlock detected'],
  ])('classifies SQLSTATE %s (%s) as transient', (code) => {
    expect(isDeterministicDbError({ code })).toBe(false);
  });

  it('treats unknown / missing codes as NOT deterministic (safer to retry)', () => {
    expect(isDeterministicDbError({ code: '99999' })).toBe(false);
    expect(isDeterministicDbError(new Error('plain'))).toBe(false);
    expect(isDeterministicDbError(undefined)).toBe(false);
  });
});
