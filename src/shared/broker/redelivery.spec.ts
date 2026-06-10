import { ConfigService } from '@nestjs/config';
import {
  DELIVERY_ATTEMPT_HEADER,
  dlqNameFor,
  nextAttempt,
  resolveDeliveryLimit,
} from './redelivery';

const configWith = (value?: string): ConfigService =>
  ({ get: () => value }) as unknown as ConfigService;

describe('redelivery', () => {
  describe('dlqNameFor', () => {
    it('appends .dlq to a topic or queue name', () => {
      expect(dlqNameFor('campaigns.send')).toBe('campaigns.send.dlq');
      expect(dlqNameFor('event-process-events.received')).toBe(
        'event-process-events.received.dlq',
      );
    });
  });

  describe('nextAttempt', () => {
    it('treats a missing header as attempt 0 → next is 1', () => {
      expect(nextAttempt({})).toBe(1);
    });

    it('increments an existing attempt header', () => {
      expect(nextAttempt({ [DELIVERY_ATTEMPT_HEADER]: '2' })).toBe(3);
    });

    it('falls back to 0 for a non-numeric or negative header', () => {
      expect(nextAttempt({ [DELIVERY_ATTEMPT_HEADER]: 'nope' })).toBe(1);
      expect(nextAttempt({ [DELIVERY_ATTEMPT_HEADER]: '-5' })).toBe(1);
    });
  });

  describe('resolveDeliveryLimit', () => {
    it('defaults to 3 when unset', () => {
      expect(resolveDeliveryLimit(configWith(undefined))).toBe(3);
      expect(resolveDeliveryLimit(configWith(''))).toBe(3);
    });

    it('honors a valid positive integer', () => {
      expect(resolveDeliveryLimit(configWith('5'))).toBe(5);
    });

    it('throws on a non-positive or non-numeric value', () => {
      expect(() => resolveDeliveryLimit(configWith('0'))).toThrow(
        /must be a positive integer/,
      );
      expect(() => resolveDeliveryLimit(configWith('abc'))).toThrow(
        /must be a positive integer/,
      );
    });
  });
});
