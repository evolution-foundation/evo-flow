import { ConfigService } from '@nestjs/config';
import { CrmInboxDispatcher } from './crm-inbox.dispatcher';
import { ChannelDispatchInput } from '../interfaces/channel-dispatcher.interface';

type FetchCall = [string, RequestInit & { headers: Record<string, string> }];

interface CrmBody {
  inbox_id: string;
  contact_id: string;
  message: { content: string; template_params?: unknown };
}

describe('CrmInboxDispatcher', () => {
  let dispatcher: CrmInboxDispatcher;
  let fetchMock: jest.Mock;

  const input: ChannelDispatchInput = {
    contactId: 'c1',
    inboxId: 'inb1',
    content: 'hello',
    campaignId: 'camp1',
    templateParams: {
      name: 'welcome',
      category: 'marketing',
      processed_params: { foo: 'bar' },
    },
  };

  beforeEach(() => {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'EVOAI_CRM_BASE_URL') return 'http://crm.test';
        if (key === 'EVOAI_CRM_API_TOKEN') return 'tok-123';
        return undefined;
      }),
    } as unknown as ConfigService;
    dispatcher = new CrmInboxDispatcher(config);
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => jest.restoreAllMocks());

  function bodyOf(call: FetchCall): CrmBody {
    return JSON.parse(call[1].body as string) as CrmBody;
  }

  it('POSTs the CrmMessagePayload to the CRM inbox with the service token', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'conv1', messages: [{ id: 'msg1' }] }),
    });

    const result = await dispatcher.dispatch(input);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0] as FetchCall;
    expect(call[0]).toBe('http://crm.test/api/v1/conversations');
    expect(call[1].method).toBe('POST');
    expect(call[1].headers['X-Service-Token']).toBe('tok-123');

    const body = bodyOf(call);
    expect(body.inbox_id).toBe('inb1');
    expect(body.contact_id).toBe('c1');
    expect(body.message.content).toBe('hello');
    expect(body.message.template_params).toEqual(input.templateParams);

    expect(result.success).toBe(true);
    expect(result.conversationId).toBe('conv1');
    expect(result.messageId).toBe('msg1');
    expect(result.statusCode).toBe(200);
    expect(typeof result.latencyMs).toBe('number');
  });

  it('returns success=false with error {code, message} on a non-ok response', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 422,
      text: () => Promise.resolve('Unprocessable'),
      headers: { get: () => null },
    });

    const result = await dispatcher.dispatch(input);

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: '422',
      message: 'CRM API error: 422 - Unprocessable',
    });
    expect(result.statusCode).toBe(422);
  });

  it('omits template_params when none are provided', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ id: 'c', messages: [] }),
    });

    await dispatcher.dispatch({ ...input, templateParams: undefined });

    const body = bodyOf(fetchMock.mock.calls[0] as FetchCall);
    expect(body.message.template_params).toBeUndefined();
  });

  // EVO-1219: transportRetries=1 makes the campaign-sender's exponential
  // backoff the single retry owner — no hidden in-transport retries.
  describe('transportRetries', () => {
    it('does not retry a network error when transportRetries=1', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

      const result = await dispatcher.dispatch({
        ...input,
        transportRetries: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
      expect(result.statusCode).toBeUndefined();
      expect(result.error?.code).toBe('DISPATCH_ERROR');
    });

    it('surfaces a 429 as a plain response when transportRetries=1 (no Retry-After wait)', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 429,
        headers: { get: () => '7' },
        text: () => Promise.resolve('slow down'),
      });

      const result = await dispatcher.dispatch({
        ...input,
        transportRetries: 1,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.statusCode).toBe(429);
    });

    it('keeps the legacy quick network retry when transportRetries is omitted', async () => {
      fetchMock
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValue({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: 'c', messages: [] }),
        });

      const result = await dispatcher.dispatch(input);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });
  });
});
