import { BadRequestException } from '@nestjs/common';
import { decodeCursor, encodeCursor, CursorPayload } from './cursor-codec';

describe('cursor-codec', () => {
  const sample: CursorPayload = {
    occurredAt: '2026-05-25T10:00:00.000Z',
    id: 'a3f1b2c4-5d6e-7f80-91a2-b3c4d5e6f708',
  };

  it('round-trips a valid payload', () => {
    const encoded = encodeCursor(sample);
    expect(typeof encoded).toBe('string');
    expect(encoded).not.toContain('"'); // base64, no raw JSON
    expect(decodeCursor(encoded)).toEqual(sample);
  });

  it('throws BadRequestException for base64 garbage that does not parse as JSON', () => {
    // '!!!' is not valid base64, decodes to empty/garbage bytes -> not JSON
    expect(() => decodeCursor('!!!')).toThrow(BadRequestException);
    expect(() => decodeCursor('!!!')).toThrow('invalid cursor');
  });

  it('throws BadRequestException for valid base64 with invalid JSON inside', () => {
    const bad = Buffer.from('{not json', 'utf8').toString('base64');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    expect(() => decodeCursor(bad)).toThrow('invalid cursor');
  });

  it('throws BadRequestException when id field is missing', () => {
    const bad = Buffer.from(
      JSON.stringify({ occurredAt: sample.occurredAt }),
      'utf8',
    ).toString('base64');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('throws BadRequestException when id is not a string (numeric)', () => {
    const bad = Buffer.from(
      JSON.stringify({ occurredAt: sample.occurredAt, id: 42 }),
      'utf8',
    ).toString('base64');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('throws BadRequestException when occurredAt is missing', () => {
    const bad = Buffer.from(JSON.stringify({ id: sample.id }), 'utf8').toString(
      'base64',
    );
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
  });

  it('throws BadRequestException when occurredAt is a string but not a parseable date', () => {
    const bad = Buffer.from(
      JSON.stringify({ occurredAt: 'not-a-date', id: sample.id }),
      'utf8',
    ).toString('base64');
    expect(() => decodeCursor(bad)).toThrow(BadRequestException);
    expect(() => decodeCursor(bad)).toThrow('invalid cursor');
  });

  it('rejects oversize input (>1024 chars) before attempting base64+JSON parse (H1)', () => {
    const oversize = 'A'.repeat(1025);
    expect(() => decodeCursor(oversize)).toThrow(BadRequestException);
    expect(() => decodeCursor(oversize)).toThrow('invalid cursor');
  });
});
