import { EventsService } from './events.service';
import { CONTACT_DELETED_INGESTED_EVENT } from '../segments/queries/contact-event-names';

/**
 * CRM-215 — ingesting a deleted-contact event must tell the deleted-contacts cache to
 * drop its snapshot, otherwise the next incremental recompute can evaluate the deletion
 * window with a stale empty cache and keep the contact in every segment.
 */
describe('EventsService.identifyEvent (contact deleted signal)', () => {
  const processing = {
    processEvent: jest
      .fn()
      .mockResolvedValue({ messageId: 'm1', status: 'ok' }),
  };
  const emitter = { emit: jest.fn() };
  const service = new EventsService(processing as any, emitter as any);

  beforeEach(() => emitter.emit.mockClear());

  it.each(['contact.deleted', 'contact_deleted'])(
    'emits the signal for %s',
    async (eventName) => {
      await service.identifyEvent({ contactId: 'c-1', eventName } as any);
      expect(emitter.emit).toHaveBeenCalledWith(
        CONTACT_DELETED_INGESTED_EVENT,
        { contactId: 'c-1' },
      );
    },
  );

  it('stays quiet for any other identify event', async () => {
    await service.identifyEvent({
      contactId: 'c-1',
      eventName: 'contact.updated',
    } as any);
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
