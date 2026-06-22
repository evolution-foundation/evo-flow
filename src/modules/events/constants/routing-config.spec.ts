import { EventRoutingConfigHelper } from './routing-config';
import { EventClassification } from '../types/routing.types';

// EVO-1839 AC10: the CRM emits the dotted `contact.custom_attribute.changed`,
// which the substring classifier did not match under the legacy underscore entry.
describe('EventRoutingConfigHelper.getEventClassification — custom attribute (EVO-1839)', () => {
  it('classifies the canonical dotted custom-attribute event as LIFECYCLE', () => {
    expect(
      EventRoutingConfigHelper.getEventClassification(
        'contact.custom_attribute.changed',
      ),
    ).toBe(EventClassification.LIFECYCLE);
  });

  it('still classifies the legacy underscore form as LIFECYCLE', () => {
    expect(
      EventRoutingConfigHelper.getEventClassification('custom_attribute_changed'),
    ).toBe(EventClassification.LIFECYCLE);
  });
});
