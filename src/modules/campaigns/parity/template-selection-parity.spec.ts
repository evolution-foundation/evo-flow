import {
  loadFixtures,
  newSelectTemplateId,
  type ParityFixture,
} from './parity-harness';

const fixtures = loadFixtures();

// New-path template selection regression (post-EVO-1227). The legacy selector
// (`templates[0]`) was removed; these pin the new packer's variant-'A'
// preference so a regression in `resolveTemplateId` is caught.
describe('campaign template selection regression: new path', () => {
  describe.each(fixtures.map((f) => [f.name, f] as const))(
    'fixture: %s',
    (_name, fixture) => {
      it('resolves to the variant-A template id', () => {
        const expected =
          fixture.campaign.templates.find((t) => t.variant === 'A')
            ?.messageTemplateId ??
          fixture.campaign.templates[0].messageTemplateId;
        expect(newSelectTemplateId(fixture.campaign)).toBe(expected);
      });
    },
  );

  it('prefers variant A even when it is not the first template', () => {
    const campaign = {
      id: 'c-ab',
      templates: [
        { messageTemplateId: 'tpl-b', variant: 'B' },
        { messageTemplateId: 'tpl-a', variant: 'A' },
      ],
    } as unknown as ParityFixture['campaign'];

    expect(newSelectTemplateId(campaign)).toBe('tpl-a');
  });
});
