import { Injectable } from '@nestjs/common';
import { Counter, register } from 'prom-client';

const TERMINAL_FAILURES_METRIC = 'evo_broker_terminal_failures_total';
const DEAD_LETTERED_METRIC = 'evo_broker_dead_lettered_total';

@Injectable()
export class BrokerMetrics {
  public readonly terminalFailures: Counter<string>;
  public readonly deadLettered: Counter<string>;

  constructor() {
    const existingTerminal = register.getSingleMetric(
      TERMINAL_FAILURES_METRIC,
    ) as Counter<string> | undefined;

    this.terminalFailures =
      existingTerminal ??
      new Counter({
        name: TERMINAL_FAILURES_METRIC,
        help: 'Total broker messages that exhausted retries and were dropped (nack with requeue=false).',
        labelNames: ['broker', 'topic'],
      });

    const existingDeadLettered = register.getSingleMetric(
      DEAD_LETTERED_METRIC,
    ) as Counter<string> | undefined;

    this.deadLettered =
      existingDeadLettered ??
      new Counter({
        name: DEAD_LETTERED_METRIC,
        help: 'Total broker messages routed to a DLQ/DLT after exceeding the redelivery limit (EVO-1677).',
        labelNames: ['broker', 'topic'],
      });
  }
}
