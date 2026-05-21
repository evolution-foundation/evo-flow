import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TrackEventDto } from './track-event.dto';

describe('TrackEventDto (EVENT_NAMES @IsIn)', () => {
  const baseValid = { messageId: 'm-1', contactId: '42' };

  it('passes for a canonical event name', async () => {
    const dto = plainToInstance(TrackEventDto, {
      ...baseValid,
      event: 'contact.created',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('fails with isIn on an unknown event name', async () => {
    const dto = plainToInstance(TrackEventDto, {
      ...baseValid,
      event: 'nope',
    });

    const errors = await validate(dto);
    const eventErr = errors.find((e) => e.property === 'event');

    expect(eventErr).toBeDefined();
    expect(eventErr?.constraints?.isIn).toBeDefined();
    expect(eventErr?.constraints?.isIn).toMatch(/event must be one of/);
  });

  it('fails when `event` is missing', async () => {
    const dto = plainToInstance(TrackEventDto, { ...baseValid });

    const errors = await validate(dto);
    const eventErr = errors.find((e) => e.property === 'event');

    expect(eventErr).toBeDefined();
    // Either isIn or isString fires on a missing string field; both prove rejection.
    expect(
      eventErr?.constraints?.isIn || eventErr?.constraints?.isString,
    ).toBeDefined();
  });
});
