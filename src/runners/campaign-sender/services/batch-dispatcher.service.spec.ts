import { BatchDispatcherService } from './batch-dispatcher.service';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
import { RateLimitedError } from '../errors/rate-limited.error';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import type { HydratedContact } from '../../../shared/crm-client/types/contact';

const template = {
  id: 'tpl-1',
  name: 'welcome',
  content: 'Hi {contact.name}, your plan is {{contact.plan}}',
  language: 'pt_BR',
  category: 'marketing',
  variables: [{ key: 'plan' }],
} as unknown as MessageTemplate;

const contact: HydratedContact = {
  id: 'contact-1',
  name: 'Ana',
  email: 'ana@example.com',
  phoneNumber: '+5511999999999',
  blocked: false,
  customAttributes: { plan: 'pro' },
  additionalAttributes: {},
};

describe('BatchDispatcherService', () => {
  let service: BatchDispatcherService;
  let findOne: jest.Mock;
  let dispatch: jest.Mock;
  let acquire: jest.Mock;
  let log: jest.Mock;
  let warn: jest.Mock;

  beforeEach(() => {
    findOne = jest.fn();
    dispatch = jest.fn();
    acquire = jest.fn().mockResolvedValue(true);
    log = jest.fn();
    warn = jest.fn();
    const db = { getRepository: () => ({ findOne }) };
    service = new BatchDispatcherService(
      db as any,
      { dispatch } as any,
      { acquire } as any,
      { log, warn } as any,
    );
  });

  describe('loadTemplate', () => {
    it('returns the template when it exists', async () => {
      findOne.mockResolvedValueOnce(template);

      await expect(service.loadTemplate('camp-1', 'tpl-1')).resolves.toBe(
        template,
      );
      expect(findOne).toHaveBeenCalledWith({ where: { id: 'tpl-1' } });
    });

    it('throws a terminal CampaignNotConfiguredError when missing', async () => {
      findOne.mockResolvedValueOnce(null);

      await expect(service.loadTemplate('camp-1', 'tpl-x')).rejects.toThrow(
        CampaignNotConfiguredError,
      );
    });
  });

  describe('dispatch', () => {
    it('delegates to CrmInboxDispatcher with rendered content and template params', async () => {
      dispatch.mockResolvedValueOnce({ success: true, latencyMs: 10 });

      await service.dispatch({
        campaignId: 'camp-1',
        inboxId: 'inbox-1',
        template,
        contact,
      });

      expect(acquire).toHaveBeenCalledWith('inbox-1');
      expect(dispatch).toHaveBeenCalledWith({
        contactId: 'contact-1',
        inboxId: 'inbox-1',
        content: 'Hi Ana, your plan is pro',
        campaignId: 'camp-1',
        templateParams: {
          name: 'welcome',
          category: 'marketing',
          language: 'pt_BR',
          processed_params: [{ key: 'plan' }],
        },
      });
    });

    it('returns the dispatcher result untouched', async () => {
      const result = {
        success: false,
        statusCode: 422,
        error: { code: '422', message: 'invalid contact' },
        latencyMs: 5,
      };
      dispatch.mockResolvedValueOnce(result);

      await expect(
        service.dispatch({
          campaignId: 'camp-1',
          inboxId: 'inbox-1',
          template,
          contact,
        }),
      ).resolves.toBe(result);
    });

    it('renders empty string for missing contact fields and attributes', async () => {
      dispatch.mockResolvedValueOnce({ success: true, latencyMs: 1 });
      const sparse: HydratedContact = {
        id: 'contact-2',
        name: '',
        blocked: false,
        customAttributes: { plan: null },
        additionalAttributes: {},
      };

      await service.dispatch({
        campaignId: 'camp-1',
        inboxId: 'inbox-1',
        template,
        contact: sparse,
      });

      const [[arg]] = dispatch.mock.calls as [[{ content: string }]];
      expect(arg.content).toBe('Hi , your plan is ');
    });
  });

  describe('rate limiting (EVO-1218)', () => {
    const input = {
      campaignId: 'camp-1',
      inboxId: 'inbox-1',
      template,
      contact,
    };

    it('acquires exactly one token on the happy path without retry logs', async () => {
      dispatch.mockResolvedValueOnce({ success: true, latencyMs: 1 });

      await service.dispatch(input);

      expect(acquire).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    // AC4: blocked once, acquired on the first retry after the 50ms sleep.
    it('retries after a blocked acquire and logs "rate-limit retry 1: acquired"', async () => {
      acquire.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      dispatch.mockResolvedValueOnce({ success: true, latencyMs: 1 });

      await service.dispatch(input);

      expect(acquire).toHaveBeenCalledTimes(2);
      expect(log).toHaveBeenCalledWith('rate-limit retry 1: acquired', {
        inboxId: 'inbox-1',
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });

    // AC3: 1 + 3 retries all blocked → transient RateLimitedError (the ack
    // policy maps non-TerminalError to nack(requeue=true)).
    it('throws RateLimitedError and logs "rate-limited: requeued" after 4 blocked attempts', async () => {
      acquire.mockResolvedValue(false);

      await expect(service.dispatch(input)).rejects.toThrow(RateLimitedError);

      expect(acquire).toHaveBeenCalledTimes(4);
      expect(dispatch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('rate-limited: requeued', {
        inboxId: 'inbox-1',
        attempts: 4,
      });
    });
  });
});
