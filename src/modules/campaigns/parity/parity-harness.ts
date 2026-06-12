import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { CampaignMessageSenderService } from '../services/campaign-message-sender.service';
import { BatchDispatcherService } from '../../../runners/campaign-sender/services/batch-dispatcher.service';
import { CampaignPackerService } from '../../../runners/campaign-packer/services/campaign-packer.service';
import { mapContactDto } from '../../../shared/crm-client/types/contact';
import { Campaign } from '../entities/campaign.entity';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import type {
  ChannelDispatchInput,
  DispatchResult,
  IChannelDispatcher,
} from '../../../shared/messaging-channels/interfaces/channel-dispatcher.interface';

/**
 * Parity harness (story 5.4 / EVO-1225). Drives the LEGACY single-contact path
 * (`CampaignMessageSenderService`, slated for removal in 5.5) and the NEW
 * distributed path (`BatchDispatcherService`) through the same fixture so the
 * specs can prove they produce identical dispatch output before the legacy code
 * is deleted.
 *
 * Both paths terminate at the channel-agnostic `CrmInboxDispatcher`; the harness
 * injects a dispatcher (a capturing stub for input parity, or the real
 * dispatcher with a mocked fetch for HTTP-body parity) and runs each path with
 * mocked repositories/clients. No real HTTP, no broker, no DB.
 */

export interface ParityFixture {
  name: string;
  campaign: {
    id: string;
    isRateLimit: boolean;
    type: string;
    channelType: string;
    description?: string;
    templates: Array<{ messageTemplateId: string; variant: string }>;
  };
  template: {
    id: string;
    name: string;
    content: string;
    language: string;
    category?: string;
    variables: unknown;
  };
  contactDto: Record<string, unknown> & { id: string };
  inboxId: string;
  channelType: string;
}

const FIXTURES_DIR = join(__dirname, 'fixtures');

export function loadFixtures(): ParityFixture[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map(
      (f) =>
        JSON.parse(
          readFileSync(join(FIXTURES_DIR, f), 'utf8'),
        ) as ParityFixture,
    );
}

const OK_RESULT: DispatchResult = {
  success: true,
  messageId: 'msg-parity',
  conversationId: 'conv-parity',
  latencyMs: 0,
};

export function capturingDispatcher(): {
  dispatcher: IChannelDispatcher;
  calls: ChannelDispatchInput[];
} {
  const calls: ChannelDispatchInput[] = [];
  return {
    calls,
    dispatcher: {
      dispatch: (input) => {
        calls.push(input);
        return Promise.resolve(OK_RESULT);
      },
    },
  };
}

const noopLogger = {
  log: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export async function runLegacy(
  fixture: ParityFixture,
  dispatcher: IChannelDispatcher,
): Promise<void> {
  const db = {
    getRepository: (entity: unknown) => {
      if (entity === Campaign)
        return { findOne: () => Promise.resolve(fixture.campaign) };
      if (entity === MessageTemplate)
        return { findOne: () => Promise.resolve(fixture.template) };
      return { update: () => Promise.resolve({ affected: 1 }) };
    },
  };
  const configService = { get: () => undefined };
  const contactsClient = {
    findById: () => Promise.resolve(fixture.contactDto),
  };

  const svc = new CampaignMessageSenderService(
    db as never,
    configService as never,
    contactsClient as never,
    dispatcher as never,
  );

  await svc.sendMessage({
    campaignId: fixture.campaign.id,
    campaignContactId: 'cc-parity',
    contactId: fixture.contactDto.id,
    inboxId: fixture.inboxId,
    templateId: fixture.template.id,
    channelType: fixture.channelType,
  });
}

export async function runNew(
  fixture: ParityFixture,
  dispatcher: IChannelDispatcher,
): Promise<void> {
  const db = {
    getRepository: () => ({ findOne: () => Promise.resolve(fixture.template) }),
  };
  const rateLimiter = { acquire: () => Promise.resolve(true) };

  const svc = new BatchDispatcherService(
    db as never,
    dispatcher as never,
    rateLimiter as never,
    noopLogger as never,
  );

  const contact = mapContactDto(fixture.contactDto as never);
  await svc.dispatch({
    campaignId: fixture.campaign.id,
    inboxId: fixture.inboxId,
    template: fixture.template as unknown as MessageTemplate,
    contact: contact as NonNullable<typeof contact>,
  });
}

/**
 * Template variant selection in each path. The legacy Temporal workflow used
 * `campaign.templates[0]` (campaign-execution.workflow.ts); the new packer uses
 * `resolveTemplateId` — `find(variant === 'A') ?? templates[0]`. They agree only
 * when variant 'A' is first (or absent); the parity spec asserts agreement and
 * documents the divergence when 'A' is not the first element.
 */
export function legacySelectTemplateId(
  campaign: ParityFixture['campaign'],
): string | undefined {
  return campaign.templates?.[0]?.messageTemplateId;
}

export function newSelectTemplateId(
  campaign: ParityFixture['campaign'],
): string {
  const packer = new CampaignPackerService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
  return (
    packer as unknown as { resolveTemplateId: (c: unknown) => string }
  ).resolveTemplateId(campaign);
}

/**
 * Strip the per-call non-deterministic fields the CrmInboxDispatcher stamps
 * (`source_id: campaign_<id>_<epochMs>` and `message.content_attributes.sent_at`)
 * so two runs of the same payload compare equal.
 */
export function normalizeHttpBody(raw: string): Record<string, unknown> {
  const body = JSON.parse(raw) as {
    source_id?: string;
    message?: { content_attributes?: Record<string, unknown> };
  };
  if (typeof body.source_id === 'string') {
    body.source_id = body.source_id.replace(/_\d+$/, '_<ts>');
  }
  if (body.message?.content_attributes) {
    delete body.message.content_attributes.sent_at;
  }
  return body as Record<string, unknown>;
}
