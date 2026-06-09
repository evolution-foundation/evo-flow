import { timingSafeEqual } from 'crypto';

/**
 * Case-insensitive header lookup. The normalized envelope preserves whatever
 * casing the provider sent (`Signature`, `svix-id`, `X-Mandrill-Signature`…),
 * so validators must not assume a canonical case.
 */
export function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) return headers[key];
  }
  return undefined;
}

/**
 * Constant-time string comparison. Returns false on length mismatch without
 * leaking timing, so it is safe to feed attacker-controlled signatures.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
