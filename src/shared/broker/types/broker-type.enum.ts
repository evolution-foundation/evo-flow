export enum BrokerType {
  KAFKA = 'kafka',
  RABBITMQ = 'rabbitmq',
}

export const BROKER_TYPE_VALUES: readonly BrokerType[] = Object.freeze(
  Object.values(BrokerType) as BrokerType[],
);
