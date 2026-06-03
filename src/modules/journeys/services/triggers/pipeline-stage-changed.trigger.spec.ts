import { PipelineStageChangedTrigger } from './pipeline-stage-changed.trigger';
import { JourneyTriggerEvent } from '../journey-trigger-processor.service';

describe('PipelineStageChangedTrigger', () => {
  let trigger: PipelineStageChangedTrigger;

  const PIPELINE = 'pipe-1';
  const FROM = 'stage-lead';
  const TO = 'stage-qualified';

  const journey = { id: 'journey-1' };

  const event = (properties: Record<string, any>): JourneyTriggerEvent => ({
    messageId: 'm1',
    contactId: 'c1',
    eventName: 'pipeline.stage_changed',
    eventType: 'track',
    properties: JSON.stringify(properties),
    timestamp: '2026-06-03T00:00:00.000Z',
  });

  const fullEvent = event({
    pipeline_id: PIPELINE,
    from_stage_id: FROM,
    to_stage_id: TO,
    conversation_id: 'conv-1',
  });

  beforeEach(() => {
    trigger = new PipelineStageChangedTrigger();
    jest
      .spyOn((trigger as any).logger, 'debug')
      .mockImplementation(() => undefined);
  });

  it('matches when all configured filters match', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: { pipelineId: PIPELINE, fromStageId: FROM, toStageId: TO },
      },
      journey,
    );

    expect(result.matches).toBe(true);
  });

  it('matches any stage change when no filters are configured', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: {},
      },
      journey,
    );

    expect(result.matches).toBe(true);
  });

  it('does not match when the pipeline differs', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: { pipelineId: 'other-pipe' },
      },
      journey,
    );

    expect(result.matches).toBe(false);
  });

  it('does not match when the to-stage differs', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: { toStageId: 'other-stage' },
      },
      journey,
    );

    expect(result.matches).toBe(false);
  });

  it('does not match when the from-stage differs', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: { fromStageId: 'other-stage' },
      },
      journey,
    );

    expect(result.matches).toBe(false);
  });

  it('matches on a partial filter (to-stage only) regardless of pipeline/from', () => {
    const result = trigger.matches(
      fullEvent,
      {
        type: 'PipelineStageChanged',
        metadata: { toStageId: TO },
      },
      journey,
    );

    expect(result.matches).toBe(true);
  });

  it('does not match a different event name', () => {
    const result = trigger.matches(
      { ...fullEvent, eventName: 'contact.created' },
      { type: 'PipelineStageChanged', metadata: { toStageId: TO } },
      journey,
    );

    expect(result.matches).toBe(false);
  });
});
