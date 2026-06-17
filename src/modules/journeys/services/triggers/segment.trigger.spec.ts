import { SegmentTrigger } from './segment.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('SegmentTrigger', () => {
  let trigger: SegmentTrigger;

  const SEGMENT = 'segment-1';
  const journey = { id: 'journey-1' };

  const event = (
    eventName: string,
    segmentId = SEGMENT,
  ): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName,
    eventType: 'track',
    properties: JSON.stringify({ segmentId }),
    timestamp: '2026-06-17T00:00:00.000Z',
  });

  const triggerWith = (metadata: Record<string, any>) => ({
    type: 'Segment',
    metadata,
  });

  beforeEach(() => {
    trigger = new SegmentTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches an "entered" trigger on a segment_entered event', () => {
    const result = trigger.matches(
      event('segment_entered'),
      triggerWith({ segmentId: SEGMENT, segmentAction: 'entered' }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('does NOT match an "entered" trigger on a segment_exited event (EVO-1763)', () => {
    const result = trigger.matches(
      event('segment_exited'),
      triggerWith({ segmentId: SEGMENT, segmentAction: 'entered' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('matches an "exited" trigger on a segment_exited event', () => {
    const result = trigger.matches(
      event('segment_exited'),
      triggerWith({ segmentId: SEGMENT, segmentAction: 'exited' }),
      journey,
    );
    expect(result.matches).toBe(true);
  });

  it('does NOT match an "exited" trigger on a segment_entered event (EVO-1763)', () => {
    const result = trigger.matches(
      event('segment_entered'),
      triggerWith({ segmentId: SEGMENT, segmentAction: 'exited' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });

  it('defaults to "entered" when no action is configured (backward compat)', () => {
    expect(
      trigger.matches(
        event('segment_entered'),
        triggerWith({ segmentId: SEGMENT }),
        journey,
      ).matches,
    ).toBe(true);
    expect(
      trigger.matches(
        event('segment_exited'),
        triggerWith({ segmentId: SEGMENT }),
        journey,
      ).matches,
    ).toBe(false);
  });

  it('does not match a non-segment event', () => {
    const result = trigger.matches(
      event('contact.label.added'),
      triggerWith({ segmentId: SEGMENT, segmentAction: 'entered' }),
      journey,
    );
    expect(result.matches).toBe(false);
  });
});
