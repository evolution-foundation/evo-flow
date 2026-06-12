import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { BatchDispatcherService } from '../../../runners/campaign-sender/services/batch-dispatcher.service';
import { CampaignPackerService } from '../../../runners/campaign-packer/services/campaign-packer.service';
import { mapContactDto } from '../../../shared/crm-client/types/contact';
import { MessageTemplate } from '../../../shared/entities/message-template.entity';
import type {
  ChannelDispatchInput,
  DispatchResult,
  IChannelDispatcher,
} from '../../../shared/messaging-channels/interfaces/channel-dispatcher.interface';

/**
 * New-path dispatch harness. EVO-1225 introduced this as a legacy↔new PARITY
 * suite; story 5.5 (EVO-1227) removed the legacy `CampaignMessageSenderService`,
 * so the legacy half retired and this is now a golden-master regression of the
 * NEW distributed path (`BatchDispatcherService`): it pins the dispatch output
 * per fixture so a future change to the sender's render/payload is caught.
 *
 * The path terminates at the channel-agnostic `CrmInboxDispatcher`; the harness
 * injects a dispatcher (a capturing stub for input snapshots, or the real
 * dispatcher with a mocked fetch for HTTP-body snapshots) and runs with mocked
 * repositories/clients. No real HTTP, no broker, no DB.
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
 * Template variant selection in the new packer: `resolveTemplateId` —
 * `find(variant === 'A') ?? templates[0]`. Pinned by the selection spec so a
 * regression in variant resolution (e.g. dropping the variant-'A' preference)
 * is caught.
 */
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
