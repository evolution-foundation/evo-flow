import { CAMPAIGNS_PACK_TOPIC } from './campaigns-pack.contract';
import { CAMPAIGNS_SEND_TOPIC } from './campaigns-send.contract';
import { CAMPAIGNS_TRACKED_TOPIC } from './campaigns-tracked.contract';
import { CAMPAIGNS_CONTROL_TOPIC } from './campaigns-control.contract';
import { EventsReceivedTopic } from './events-received.contract';
import { EVENTS_ENRICHED_TOPIC } from './events-enriched.contract';
import { EVENTS_FAILED_TOPIC } from './events-failed.contract';

/**
 * Canonical union of broker topic names used by adapter `publish` /
 * `subscribe` call sites. `EventsReceivedTopic` is a template-literal
 * type that expands to one concrete string per Platform (e.g.
 * `'events.received.evolution-api'`); use `getEventsReceivedTopic(platform)`
 * from `./events-received.contract` to construct the string at call time.
 */
export type BrokerTopic =
  | typeof CAMPAIGNS_PACK_TOPIC
  | typeof CAMPAIGNS_SEND_TOPIC
  | typeof CAMPAIGNS_TRACKED_TOPIC
  | typeof CAMPAIGNS_CONTROL_TOPIC
  | EventsReceivedTopic
  | typeof EVENTS_ENRICHED_TOPIC
  | typeof EVENTS_FAILED_TOPIC;

/**
 * Topics that adapters actually publish/subscribe today. `events.enriched`
 * is consumed in-process by stories 3.6/3.7 (see events-enriched.contract.ts)
 * and is intentionally NOT in this list — adapters iterating this array to
 * set up subscriptions would otherwise create a no-op subscription on it.
 * `events.received.<platform>` is parameterized and handled per-platform via
 * `getEventsReceivedTopic(...)`; consumers subscribe via the wildcard
 * patterns below.
 */
export const BROKER_PUBLISH_TOPICS = [
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
  CAMPAIGNS_CONTROL_TOPIC,
  EVENTS_FAILED_TOPIC,
] as const;

/**
 * All 6 named-contract topic strings (the 5 above + `events.enriched`).
 * Used for audit/documentation/inventory only — NOT for adapter wiring.
 */
export const ALL_CONTRACT_TOPIC_NAMES = [
  ...BROKER_PUBLISH_TOPICS,
  EVENTS_ENRICHED_TOPIC,
] as const;

/**
 * Wildcard subscription pattern for the parametric `events.received.<platform>`
 * topic family. Kafka uses a regex (matches one segment after the prefix);
 * RabbitMQ uses the `#` hash wildcard on a topic exchange. The two adapters
 * pick the appropriate one — adapter call-sites must not assume a single
 * canonical form (see story 3.3 Notas técnicas).
 */
export const EVENTS_RECEIVED_KAFKA_REGEX = /^events\.received\.[^.]+$/;
export const EVENTS_RECEIVED_RABBITMQ_BINDING = 'events.received.#';
