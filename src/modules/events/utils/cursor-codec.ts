import { BadRequestException } from '@nestjs/common';

export interface CursorPayload {
  occurredAt: string;
  id: string;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

// Hard cap on the encoded cursor length. A legitimate cursor is ~120 chars
// (base64 of {occurredAt:24, id:36, ~10 punctuation}); 1024 leaves plenty of
// headroom while bounding the cost of base64 + JSON.parse on a hostile input.
const MAX_CURSOR_LENGTH = 1024;

export function decodeCursor(raw: string): CursorPayload {
  if (raw.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException('invalid cursor');
  }

  let decoded: unknown;
  try {
    const json = Buffer.from(raw, 'base64').toString('utf8');
    decoded = JSON.parse(json);
  } catch {
    throw new BadRequestException('invalid cursor');
  }

  if (
    !decoded ||
    typeof decoded !== 'object' ||
    typeof (decoded as CursorPayload).occurredAt !== 'string' ||
    typeof (decoded as CursorPayload).id !== 'string'
  ) {
    throw new BadRequestException('invalid cursor');
  }

  const payload = decoded as CursorPayload;
  // occurredAt must be a parseable timestamp; otherwise downstream
  // `new Date(...).toISOString()` raises RangeError → 500.
  if (Number.isNaN(Date.parse(payload.occurredAt))) {
    throw new BadRequestException('invalid cursor');
  }

  return payload;
}
