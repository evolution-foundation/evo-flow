import { BatchDispatcherService } from './batch-dispatcher.service';
import { CampaignNotConfiguredError } from '../errors/campaign-not-configured.error';
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

  beforeEach(() => {
    findOne = jest.fn();
    dispatch = jest.fn();
    const db = { getRepository: () => ({ findOne }) };
    service = new BatchDispatcherService(db as any, { dispatch } as any);
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

      expect(dispatch.mock.calls[0][0].content).toBe('Hi , your plan is ');
    });
  });
});
