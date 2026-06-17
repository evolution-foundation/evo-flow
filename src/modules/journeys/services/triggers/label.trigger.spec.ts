import { LabelTrigger } from './label.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('LabelTrigger', () => {
  let trigger: LabelTrigger;

  const LABEL = 'label-1';
  const journey = { id: 'journey-1' };

  const event = (eventName: string, labelId = LABEL): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'track',
    properties: JSON.stringify({ labelId }),
    timestamp: '2026-06-17T00:00:00.000Z',
  });

  const triggerWith = (metadata: Record<string, any>) => ({
    type: 'Label',
    metadata,
  });

  beforeEach(() => {
    trigger = new LabelTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches an "applied" trigger on a label-added event', () => {
    const result = trigger.matches(
      event('contact.label.added'),
      triggerWith({ labelId: LABEL, labelAction: 'applied' }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('does NOT match an "applied" trigger on a label-removed event (EVO-1763)', () => {
    const result = trigger.matches(
      event('contact.label.removed'),
      triggerWith({ labelId: LABEL, labelAction: 'applied' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('matches a "removed" trigger on a label-removed event', () => {
    const result = trigger.matches(
      event('contact.label.removed'),
      triggerWith({ labelId: LABEL, labelAction: 'removed' }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('does NOT match a "removed" trigger on a label-added event (EVO-1763)', () => {
    const result = trigger.matches(
      event('contact.label.added'),
      triggerWith({ labelId: LABEL, labelAction: 'removed' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('defaults to "applied" when no action is configured (backward compat)', () => {
    expect(
      trigger.matches(
        event('contact.label.added'),
        triggerWith({ labelId: LABEL }),
        journey,
      ).matches,
    ).toBe(true);
    expect(
      trigger.matches(
        event('contact.label.removed'),
        triggerWith({ labelId: LABEL }),
        journey,
      ).matches,
    ).toBe(false);
  });

  it('does not match a non-label event', () => {
    const result = trigger.matches(
      event('segment_entered'),
      triggerWith({ labelId: LABEL, labelAction: 'applied' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });
});
