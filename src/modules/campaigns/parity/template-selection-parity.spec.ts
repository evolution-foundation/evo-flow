import {
  loadFixtures,
  legacySelectTemplateId,
  newSelectTemplateId,
  type ParityFixture,
} from './parity-harness';

const fixtures = loadFixtures();

describe('campaign template selection parity: legacy vs new', () => {
  describe.each(fixtures.map((f) => [f.name, f] as const))(
    'fixture: %s',
    (_name, fixture) => {
      it('legacy templates[0] and new find(A)??[0] resolve the same template id', () => {
        expect(newSelectTemplateId(fixture.campaign)).toBe(
          legacySelectTemplateId(fixture.campaign),
        );
      });
    },
  );

  it('DOCUMENTED DIVERGENCE: variant A not first → paths pick different templates', () => {
    // The legacy workflow used campaign.templates[0]; the new packer prefers
    // variant 'A'. A B-first ordering makes them choose different templates —
    // a real A/B regression risk for the 5.5 cleanup. The CRM does NOT neutralize
    // it (a different template id renders different content).
    const campaign = {
      id: 'c-divergent',
      templates: [
        { messageTemplateId: 'tpl-b', variant: 'B' },
        { messageTemplateId: 'tpl-a', variant: 'A' },
      ],
    } as unknown as ParityFixture['campaign'];

    expect(legacySelectTemplateId(campaign)).toBe('tpl-b');
    expect(newSelectTemplateId(campaign)).toBe('tpl-a');
    expect(newSelectTemplateId(campaign)).not.toBe(
      legacySelectTemplateId(campaign),
    );
  });
});
