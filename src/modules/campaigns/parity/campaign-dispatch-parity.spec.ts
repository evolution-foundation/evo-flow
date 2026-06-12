import { CrmInboxDispatcher } from '../../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';
import {
  loadFixtures,
  capturingDispatcher,
  runLegacy,
  runNew,
  normalizeHttpBody,
} from './parity-harness';

const fixtures = loadFixtures();

const omitTransportRetries = (
  input: Record<string, unknown>,
): Record<string, unknown> => {
  const copy = { ...input };
  delete copy.transportRetries;
  return copy;
};

type FetchCall = [
  string,
  { method: string; headers: Record<string, string>; body: string },
];

describe('campaign dispatch parity: legacy vs new', () => {
  it('discovers all campaign-type fixtures', () => {
    expect(fixtures.map((f) => f.name).sort()).toEqual([
      'simple-email',
      'simple-whatsapp',
      'split',
      'testAB',
    ]);
  });

  describe.each(fixtures.map((f) => [f.name, f] as const))(
    'fixture: %s',
    (_name, fixture) => {
      it('builds an identical CrmInboxDispatcher input (modulo transportRetries)', async () => {
        const legacy = capturingDispatcher();
        await runLegacy(fixture, legacy.dispatcher);

        const next = capturingDispatcher();
        await runNew(fixture, next.dispatcher);

        expect(legacy.calls).toHaveLength(1);
        expect(next.calls).toHaveLength(1);

        const legacyInput = omitTransportRetries(
          legacy.calls[0] as unknown as Record<string, unknown>,
        );
        const newInput = omitTransportRetries(
          next.calls[0] as unknown as Record<string, unknown>,
        );

        expect(newInput).toEqual(legacyInput);
        // High-signal sub-assertions so a failure names the diverging facet.
        expect(newInput.content).toBe(legacyInput.content);
        expect(newInput.templateParams).toEqual(legacyInput.templateParams);
      });

      it('builds an identical HTTP request (URL, headers, body — volatile fields normalized)', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({ id: 'conv', messages: [{ id: 'msg' }] }),
        });
        global.fetch = fetchMock as unknown as typeof fetch;

        const config = {
          get: (key: string) =>
            key === 'EVOAI_CRM_BASE_URL'
              ? 'http://crm.test'
              : key === 'EVOAI_CRM_API_TOKEN'
                ? 'tok-parity'
                : undefined,
        };
        const dispatcher = new CrmInboxDispatcher(config as never);

        await runLegacy(fixture, dispatcher);
        const legacyCall = fetchMock.mock.calls[0] as FetchCall;
        const legacyUrl = legacyCall[0];
        const legacyHeaders = legacyCall[1].headers;
        const legacyBody = normalizeHttpBody(legacyCall[1].body);

        fetchMock.mockClear();

        await runNew(fixture, dispatcher);
        const newCall = fetchMock.mock.calls[0] as FetchCall;

        expect(newCall[0]).toBe(legacyUrl);
        expect(newCall[1].method).toBe('POST');
        expect(newCall[1].headers).toEqual(legacyHeaders);
        expect(normalizeHttpBody(newCall[1].body)).toEqual(legacyBody);
      });
    },
  );
});
