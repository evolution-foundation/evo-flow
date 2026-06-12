import { CrmInboxDispatcher } from '../../../shared/messaging-channels/dispatchers/crm-inbox.dispatcher';
import {
  loadFixtures,
  capturingDispatcher,
  runNew,
  normalizeHttpBody,
} from './parity-harness';

const fixtures = loadFixtures();

type FetchCall = [
  string,
  { method: string; headers: Record<string, string>; body: string },
];

// New-path dispatch regression (post-EVO-1227). The legacy↔new comparison
// retired with CampaignMessageSenderService; these snapshots pin the new
// pipeline's dispatch output per fixture, so a render/payload change fails the
// gate (run jest -u to re-baseline an intentional change).
describe('campaign dispatch regression: new path golden master', () => {
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
      it('builds the expected CrmInboxDispatcher input', async () => {
        const cap = capturingDispatcher();
        await runNew(fixture, cap.dispatcher);

        expect(cap.calls).toHaveLength(1);
        expect(cap.calls[0]).toMatchSnapshot();
      });

      it('builds the expected HTTP request (volatile fields normalized)', async () => {
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

        await runNew(fixture, dispatcher);
        const call = fetchMock.mock.calls[0] as FetchCall;

        expect(call[0]).toBe('http://crm.test/api/v1/conversations');
        expect(call[1].method).toBe('POST');
        expect(call[1].headers).toMatchSnapshot('headers');
        expect(normalizeHttpBody(call[1].body)).toMatchSnapshot('body');
      });
    },
  );
});
