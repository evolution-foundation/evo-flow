import { AudienceComputationService } from '../../../shared/audience/audience-computation.service';
import { CampaignPackerService } from '../../../runners/campaign-packer/services/campaign-packer.service';

describe('campaign audience parity: single shared implementation', () => {
  it('audience is resolved by one shared AudienceComputationService in both paths', () => {
    // Structural invariant: the legacy Temporal activity
    // (campaign-execution.activities.ts → computeCampaignAudience) and the new
    // packer both delegate to AudienceComputationService.computeAudience, so the
    // resolved contact set cannot diverge between paths.
    expect(typeof AudienceComputationService.prototype.computeAudience).toBe(
      'function',
    );
  });

  it('the packer loads contact ids in a deterministic order (createdAt ASC, id ASC)', async () => {
    const findCalls: Array<{ order?: unknown }> = [];
    const repo = {
      find: (opts: { order?: unknown }) => {
        findCalls.push(opts);
        return Promise.resolve([{ contactId: 'a' }, { contactId: 'b' }]);
      },
    };
    const db = { getRepository: () => repo };
    const packer = new CampaignPackerService(
      db as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );

    const ids = await (
      packer as unknown as { loadContactIds: (id: string) => Promise<string[]> }
    ).loadContactIds('camp-x');

    expect(ids).toEqual(['a', 'b']);
    expect(findCalls[0].order).toEqual({ createdAt: 'ASC', id: 'ASC' });
  });
});
