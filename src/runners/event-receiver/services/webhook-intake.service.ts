import { Inject, Injectable } from '@nestjs/common';
import { IncomingHttpHeaders } from 'http';
import {
  IMESSAGE_BROKER,
  IMessageBroker,
} from '../../../shared/broker/interfaces/message-broker.interface';
import {
  getEventsReceivedTopic,
  isEventsReceivedContract,
} from '../../../shared/broker/contracts';
import { StructuredLoggerService } from '../../../shared/logger/structured-logger.service';
import { PlatformDetectorService } from './platform-detector.service';
import { PayloadNormalizerService } from './payload-normalizer.service';

const LOG_CONTEXT = 'WebhookIntakeService';

export interface WebhookIntakePayload {
  pathSegment: string;
  rawBody?: Buffer;
  headers: IncomingHttpHeaders;
  sourceIp: string;
}

/**
 * Bridges the webhook receiver to the broker (story 3.2 / EVO-1209): detect the
 * platform from the URL path, normalize into the `events.received.<platform>`
 * envelope, and publish via IMessageBroker. A publish failure throws, which the
 * WebhooksController turns into a 503 (Retry-After) for provider redelivery.
 *
 * Does NOT validate signatures (story 3.4) or process the payload (3.3+).
 */
@Injectable()
export class WebhookIntakeService {
  constructor(
    @Inject(IMESSAGE_BROKER) private readonly broker: IMessageBroker,
    private readonly detector: PlatformDetectorService,
    private readonly normalizer: PayloadNormalizerService,
    private readonly logger: StructuredLoggerService,
  ) {}

  async intake(payload: WebhookIntakePayload): Promise<void> {
    const platform = this.detector.detect(payload.pathSegment);
    const envelope = this.normalizer.build({
      platform,
      rawPayload: payload.rawBody?.toString('utf8') ?? null,
      headers: payload.headers,
      sourceIp: payload.sourceIp,
    });

    // Contract validation is a drift detector, not a gate: a non-UUID inbound
    // correlationId (the correlation infra allows safe tokens) would fail the
    // events.received schema, but dropping the event over that is worse than
    // publishing it — so warn and continue. The 503 path is reserved for a real
    // broker publish failure below. `ingestionId` is read before the guard so
    // the false branch (narrowed to `never`) does not lose the envelope type.
    const { ingestionId } = envelope;
    if (!isEventsReceivedContract(envelope)) {
      this.logger.warn(
        `events.received envelope failed contract validation (platform=${platform}, ingestionId=${ingestionId}) — publishing anyway`,
        LOG_CONTEXT,
      );
    }

    const topic = getEventsReceivedTopic(platform);
    await this.broker.publish(topic, envelope);

    this.logger.log(
      `Published webhook to ${topic} (ingestionId=${envelope.ingestionId})`,
      LOG_CONTEXT,
    );
  }
}
