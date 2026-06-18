import { Inject, Injectable } from '@nestjs/common';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
} from '../../shared/broker/interfaces/message-broker.interface';
import { getProcessingConfig } from '../../modules/processing/config/processing.config';
import { expectedBrokerTopics } from '../health-topics';
import { HealthIndicator, IndicatorResult } from './health-indicator.interface';
import { withTimeout } from '../with-timeout';

/**
 * Readiness probe for the message broker: transport connectivity plus existence
 * of the topics this RUN_MODE consumes (see `expectedBrokerTopics`).
 */
@Injectable()
export class BrokerHealthIndicator implements HealthIndicator {
  readonly name = 'broker';

  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
  ) {}

  async check(): Promise<IndicatorResult> {
    const mode = getProcessingConfig().runMode;
    try {
      const { connected, missingTopics } = await withTimeout(
        () => this.broker.healthCheck(expectedBrokerTopics(mode)),
        3000,
        this.name,
      );
      if (connected && missingTopics.length === 0) {
        return { name: this.name, status: 'up' };
      }
      return {
        name: this.name,
        status: 'down',
        error: !connected ? 'broker not connected' : 'missing topics',
        detail: { missingTopics },
      };
    } catch (err) {
      return { name: this.name, status: 'down', error: (err as Error).message };
    }
  }
}
