import {
  capturingDispatcher,
  runNew,
  type ParityFixture,
} from './parity-harness';

const fixture = (
  content: string,
  customAttributes: Record<string, unknown>,
): ParityFixture => ({
  name: 'render-edge',
  campaign: {
    id: 'c-render',
    isRateLimit: false,
    type: 'simple',
    channelType: 'Channel::Whatsapp',
    templates: [{ messageTemplateId: 't', variant: 'A' }],
  },
  template: {
    id: 't',
    name: 'render',
    content,
    language: 'pt_BR',
    category: 'marketing',
    variables: [],
  },
  contactDto: {
    id: 'ct-render',
    name: 'Ana',
    email: 'ana@example.com',
    phone_number: '+5511900000000',
    custom_attributes: customAttributes,
  },
  inboxId: 'inb-render',
  channelType: 'whatsapp',
});

const renderedContent = async (fx: ParityFixture): Promise<string> => {
  const cap = capturingDispatcher();
  await runNew(fx, cap.dispatcher);
  return cap.calls[0].content;
};

// New-path render regression (post-EVO-1227). The legacy renderer was removed;
// these pin the new `BatchDispatcherService.renderContent` behavior (the content
// only reaches the contact on the not-resolved fallback — the CRM otherwise
// re-renders from processed_params).
describe('campaign template render regression: new path', () => {
  it('renders single-brace scalar variables', async () => {
    const content = await renderedContent(
      fixture('Oi {contact.name}, plano {contact.plan}.', { plan: 'pro' }),
    );
    expect(content).toBe('Oi Ana, plano pro.');
  });

  it('renders double-brace variables (before single-brace)', async () => {
    const content = await renderedContent(fixture('Oi {{contact.name}}!', {}));
    expect(content).toBe('Oi Ana!');
  });

  it('JSON-stringifies object-valued custom attributes', async () => {
    const content = await renderedContent(
      fixture('meta {contact.meta}', { meta: { a: 1 } }),
    );
    expect(content).toBe('meta {"a":1}');
  });
});
