import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IdentifyEventDto } from './identify-event.dto';

describe('IdentifyEventDto (EVENT_NAMES @IsIn, optional)', () => {
  const baseValid = { messageId: 'm-1', contactId: '42' };

  it('passes for a canonical eventName', async () => {
    const dto = plainToInstance(IdentifyEventDto, {
      ...baseValid,
      eventName: 'contact.updated',
    });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });

  it('fails with isIn on an unknown eventName', async () => {
    const dto = plainToInstance(IdentifyEventDto, {
      ...baseValid,
      eventName: 'nope',
    });

    const errors = await validate(dto);
    const eventErr = errors.find((e) => e.property === 'eventName');

    expect(eventErr).toBeDefined();
    expect(eventErr?.constraints?.isIn).toBeDefined();
    expect(eventErr?.constraints?.isIn).toMatch(/eventName must be one of/);
  });

  it('passes when eventName is absent (optional short-circuits @IsIn)', async () => {
    const dto = plainToInstance(IdentifyEventDto, { ...baseValid });

    const errors = await validate(dto);

    expect(errors).toHaveLength(0);
  });
});
