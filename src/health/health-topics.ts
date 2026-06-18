import { RunMode } from '../modules/processing/enums/run-mode.enum';
import {
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_CONTROL_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
} from '../shared/broker/contracts';

/**
 * Topics whose broker-side object the `/ready` broker check must confirm exists,
 * per RUN_MODE (EVO-1226 [5.1]).
 *
 * Rule: list only the topics a mode CONSUMES. A topic a mode merely publishes is
 * created lazily on first publish (Kafka auto-create / RabbitMQ assertExchange),
 * so requiring it would couple this pod's readiness to another pod's activity.
 * Modes that subscribe to dynamic/parametric topics (the `events.received.<platform>`
 * family) return `[]` ⇒ connection-only verification.
 */
export function expectedBrokerTopics(mode: RunMode): string[] {
  switch (mode) {
    case RunMode.CAMPAIGN_PACKER:
      // Packer consumes both campaigns.pack and campaigns.control
      // (CampaignsControlConsumer in campaign-packer.module.ts) — gate on both.
      return [CAMPAIGNS_PACK_TOPIC, CAMPAIGNS_CONTROL_TOPIC];
    case RunMode.CAMPAIGN_SENDER:
      return [CAMPAIGNS_SEND_TOPIC, CAMPAIGNS_CONTROL_TOPIC];
    case RunMode.CAMPAIGN_TRACKER:
      return [CAMPAIGNS_TRACKED_TOPIC];
    case RunMode.EVENT_RECEIVER:
    case RunMode.EVENT_PROCESS:
    default:
      return [];
  }
}
