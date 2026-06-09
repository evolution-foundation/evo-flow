import { StructuredLoggerService } from './structured-logger.service';
import * as correlationUtil from '../correlation/correlation.util';

describe('StructuredLoggerService', () => {
  let writeSpy: jest.SpyInstance;
  let correlationSpy: jest.SpyInstance;
  const ORIGINAL_RUN_MODE = process.env.RUN_MODE;

  function writtenLines(): string[] {
    const calls = writeSpy.mock.calls as unknown[][];
    return calls.map((call) => String(call[0]));
  }

  function lastRecord(): Record<string, unknown> {
    const lines = writtenLines();
    return JSON.parse(lines[lines.length - 1]) as Record<string, unknown>;
  }

  beforeEach(() => {
    process.env.RUN_MODE = 'event-receiver';
    writeSpy = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
    correlationSpy = jest
      .spyOn(correlationUtil, 'readCorrelationIdFromCls')
      .mockReturnValue('corr-123');
  });

  afterEach(() => {
    writeSpy.mockRestore();
    correlationSpy.mockRestore();
    process.env.RUN_MODE = ORIGINAL_RUN_MODE;
  });

  it('emits a single JSON line with all mandatory fields (AC1)', () => {
    const logger = new StructuredLoggerService();
    logger.log('hello world', 'TestContext');

    const raw = writtenLines()[0];
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.indexOf('\n')).toBe(raw.length - 1);

    const record = lastRecord();
    expect(record).toMatchObject({
      service: 'event-receiver',
      level: 'info',
      correlationId: 'corr-123',
      msg: 'hello world',
      context: 'TestContext',
    });
    expect(typeof record.timestamp).toBe('string');
    expect(new Date(record.timestamp as string).toISOString()).toBe(
      record.timestamp,
    );
  });

  it('sets service to the current RUN_MODE', () => {
    process.env.RUN_MODE = 'campaign-sender';
    const logger = new StructuredLoggerService();
    logger.log('x');
    expect(lastRecord().service).toBe('campaign-sender');
  });

  it('injects correlationId from the CLS', () => {
    correlationSpy.mockReturnValue('abc-999');
    const logger = new StructuredLoggerService();
    logger.log('x');
    expect(lastRecord().correlationId).toBe('abc-999');
  });

  it('maps each method to its level', () => {
    const logger = new StructuredLoggerService();
    logger.warn('w');
    expect(lastRecord().level).toBe('warn');
    logger.error('e');
    expect(lastRecord().level).toBe('error');
  });

  it('surfaces campaignId from an object context', () => {
    const logger = new StructuredLoggerService();
    logger.log('x', { context: 'Ctx', campaignId: 'camp-1' });
    expect(lastRecord()).toMatchObject({
      context: 'Ctx',
      campaignId: 'camp-1',
    });
  });

  it('redacts PII keys at info level', () => {
    const logger = new StructuredLoggerService();
    logger.log('x', { context: 'Ctx', phone: '+5511999999999', tag: 'ok' });
    const record = lastRecord();
    expect((record.meta as Record<string, unknown>).phone).toBe('[REDACTED]');
    expect((record.meta as Record<string, unknown>).tag).toBe('ok');
  });

  it('redacts PII nested in objects and arrays', () => {
    const logger = new StructuredLoggerService();
    logger.log('x', {
      context: 'Ctx',
      contact: { phone: '+5511999999999', name: 'Ana' },
      recipients: [{ email: 'a@x.com' }],
    });
    const meta = lastRecord().meta as Record<string, unknown>;
    const contact = meta.contact as Record<string, unknown>;
    const recipients = meta.recipients as Array<Record<string, unknown>>;
    expect(contact.phone).toBe('[REDACTED]');
    expect(contact.name).toBe('Ana');
    expect(recipients[0].email).toBe('[REDACTED]');
  });
});
