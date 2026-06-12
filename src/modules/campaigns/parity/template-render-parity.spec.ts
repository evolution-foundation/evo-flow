import {
  capturingDispatcher,
  runLegacy,
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

const renderedContent = async (
  run: typeof runLegacy,
  fx: ParityFixture,
): Promise<string> => {
  const cap = capturingDispatcher();
  await run(fx, cap.dispatcher);
  return cap.calls[0].content;
};

describe('campaign template render parity (fallback content) + documented divergences', () => {
  it('single-brace scalar variables render byte-identically', async () => {
    const fx = fixture('Oi {contact.name}, plano {contact.plan}.', {
      plan: 'pro',
    });
    const legacy = await renderedContent(runLegacy, fx);
    const next = await renderedContent(runNew, fx);
    expect(next).toBe('Oi Ana, plano pro.');
    expect(next).toBe(legacy);
  });

  it('DOCUMENTED DIVERGENCE: legacy mangles {{double-brace}} (inner {contact.x} consumed first)', async () => {
    // Only reaches the contact in the not-resolved fallback path; when the CRM
    // resolves the template it re-renders from processed_params and overwrites
    // this content. Documented so a future change to either renderer is noticed.
    const fx = fixture('Oi {{contact.name}}!', {});
    const legacy = await renderedContent(runLegacy, fx);
    const next = await renderedContent(runNew, fx);
    expect(next).toBe('Oi Ana!');
    expect(legacy).toBe('Oi {Ana}!');
    expect(next).not.toBe(legacy);
  });

  it('DOCUMENTED DIVERGENCE: object custom attribute — legacy String() vs new JSON.stringify', async () => {
    const fx = fixture('meta {contact.meta}', { meta: { a: 1 } });
    const legacy = await renderedContent(runLegacy, fx);
    const next = await renderedContent(runNew, fx);
    expect(next).toBe('meta {"a":1}');
    expect(legacy).toBe('meta [object Object]');
    expect(next).not.toBe(legacy);
  });
});
