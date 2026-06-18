import { expectedBrokerTopics } from './health-topics';
import { RunMode } from '../modules/processing/enums/run-mode.enum';
import {
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_CONTROL_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
} from '../shared/broker/contracts';

describe('expectedBrokerTopics', () => {
  it('campaign-packer gates only on the topic it consumes (campaigns.pack)', () => {
    expect(expectedBrokerTopics(RunMode.CAMPAIGN_PACKER)).toEqual([
      CAMPAIGNS_PACK_TOPIC,
    ]);
  });

  it('campaign-sender gates on campaigns.send + campaigns.control', () => {
    expect(expectedBrokerTopics(RunMode.CAMPAIGN_SENDER)).toEqual([
      CAMPAIGNS_SEND_TOPIC,
      CAMPAIGNS_CONTROL_TOPIC,
    ]);
  });

  it('campaign-tracker gates on campaigns.tracked', () => {
    expect(expectedBrokerTopics(RunMode.CAMPAIGN_TRACKER)).toEqual([
      CAMPAIGNS_TRACKED_TOPIC,
    ]);
  });

  it('event-family modes are connection-only (empty list)', () => {
    expect(expectedBrokerTopics(RunMode.EVENT_RECEIVER)).toEqual([]);
    expect(expectedBrokerTopics(RunMode.EVENT_PROCESS)).toEqual([]);
  });

  it('does not gate on a topic a mode only publishes (packer omits campaigns.send)', () => {
    expect(expectedBrokerTopics(RunMode.CAMPAIGN_PACKER)).not.toContain(
      CAMPAIGNS_SEND_TOPIC,
    );
  });
});
