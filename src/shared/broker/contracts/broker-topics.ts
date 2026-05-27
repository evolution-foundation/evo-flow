import { CAMPAIGNS_PACK_TOPIC } from './campaigns-pack.contract';
import { CAMPAIGNS_SEND_TOPIC } from './campaigns-send.contract';
import { CAMPAIGNS_TRACKED_TOPIC } from './campaigns-tracked.contract';
import { CAMPAIGNS_CONTROL_TOPIC } from './campaigns-control.contract';
import {
  EVENTS_RECEIVED_TOPIC_PREFIX,
  EventsReceivedTopic,
} from './events-received.contract';
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

export const STATIC_BROKER_TOPICS = [
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
  CAMPAIGNS_CONTROL_TOPIC,
  EVENTS_ENRICHED_TOPIC,
  EVENTS_FAILED_TOPIC,
] as const;

export const EVENTS_RECEIVED_TOPIC_PATTERN =
  `${EVENTS_RECEIVED_TOPIC_PREFIX}.*` as const;
