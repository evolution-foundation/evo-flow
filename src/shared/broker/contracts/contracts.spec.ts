import {
  ALL_CONTRACT_TOPIC_NAMES,
  BROKER_PUBLISH_TOPICS,
  CAMPAIGNS_CONTROL_TOPIC,
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
  EVENTS_ENRICHED_TOPIC,
  EVENTS_FAILED_TOPIC,
  EVENTS_RECEIVED_KAFKA_REGEX,
  EVENTS_RECEIVED_RABBITMQ_BINDING,
  EVENTS_RECEIVED_TOPIC_PREFIX,
  PLATFORMS,
  getEventsReceivedTopic,
  isCampaignsControlContract,
  isCampaignsPackContract,
  isCampaignsSendContract,
  isCampaignsTrackedContract,
  isEventsEnrichedContract,
  isEventsFailedContract,
  isEventsReceivedContract,
  isPlatform,
} from './index';

const VALID_CORRELATION_ID = '550e8400-e29b-41d4-a716-446655440000';
const VALID_INGESTION_ID = 'b4f8c3e2-0001-4abc-9def-1234567890ab';
const NON_V4_UUID = '00000000-0000-1000-8000-000000000000';
const VALID_ISO = '2026-05-14T10:00:00.000Z';

function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

const validPack = {
  campaignId: 'abc',
  triggeredAt: VALID_ISO,
  triggeredBy: 'schedule',
  correlationId: VALID_CORRELATION_ID,
};

const validSend = {
  campaignId: 'abc',
  page: 1,
  totalPages: 600,
  contactIds: ['c1', 'c2', 'c3'],
  templateId: 'tpl-1',
  channelType: 'email',
  correlationId: VALID_CORRELATION_ID,
};

const validTracked = {
  campaignId: 'abc',
  page: 1,
  sentCount: 100,
  failedCount: 0,
  completed: false,
  correlationId: VALID_CORRELATION_ID,
};

const validControl = {
  campaignId: 'abc',
  action: 'pause' as const,
  correlationId: VALID_CORRELATION_ID,
};

const validReceived = {
  platform: 'evolution-api' as const,
  rawPayload: { event: 'delivered' },
  headers: { 'content-type': 'application/json' },
  receivedAt: VALID_ISO,
  sourceIp: '203.0.113.42',
  ingestionId: VALID_INGESTION_ID,
  correlationId: VALID_CORRELATION_ID,
};

const validEnriched = {
  contactId: 'contact-123',
  eventType: 'message.delivered',
  properties: {
    messageId: 'msg-1',
    occurredAt: '2026-05-14T10:00:00Z',
  },
  enrichment: {
    ua: {
      browser: { name: 'Chrome', version: '90.0.1' },
      os: { name: 'iOS', version: '14.0' },
      device: { type: 'mobile', vendor: 'Apple', model: 'iPhone' },
    },
    geo: { country: 'US', region: 'CA', city: 'San Francisco' },
    botMarkers: { isBot: false, isDatacenter: false },
  },
  correlationId: VALID_CORRELATION_ID,
};

const validFailed = {
  originalTopic: 'events.received.evolution-api',
  originalPayload: { event: 'delivered' },
  failureReason: 'clickhouse_insert_exhausted_retries',
  attempts: 3,
  lastFailureAt: VALID_ISO,
  correlationId: VALID_CORRELATION_ID,
};

const ALL_CONTRACTS: Array<
  [string, (p: unknown) => boolean, Record<string, unknown>]
> = [
  ['campaigns.pack', isCampaignsPackContract, validPack],
  ['campaigns.send', isCampaignsSendContract, validSend],
  ['campaigns.tracked', isCampaignsTrackedContract, validTracked],
  ['campaigns.control', isCampaignsControlContract, validControl],
  ['events.received', isEventsReceivedContract, validReceived],
  ['events.enriched', isEventsEnrichedContract, validEnriched],
  ['events.failed', isEventsFailedContract, validFailed],
];

describe('broker contracts — cross-topic invariants', () => {
  it.each(ALL_CONTRACTS)(
    '%s accepts a fully-valid payload',
    (_label, guard, valid) => {
      expect(guard(valid)).toBe(true);
    },
  );

  it.each(ALL_CONTRACTS)(
    '%s rejects a payload missing correlationId (AC #2)',
    (_label, guard, valid) => {
      expect(guard(omit(valid, 'correlationId'))).toBe(false);
    },
  );

  it.each(ALL_CONTRACTS)(
    '%s rejects a payload with a non-UUID correlationId',
    (_label, guard, valid) => {
      expect(guard({ ...valid, correlationId: 'not-a-uuid' })).toBe(false);
    },
  );

  it.each(ALL_CONTRACTS)(
    '%s rejects a non-v4 UUID correlationId (strict v4)',
    (_label, guard, valid) => {
      expect(guard({ ...valid, correlationId: NON_V4_UUID })).toBe(false);
    },
  );

  it.each(ALL_CONTRACTS)(
    '%s rejects unknown extra fields (strict schema)',
    (_label, guard, valid) => {
      expect(guard({ ...valid, junk: 'extra' })).toBe(false);
    },
  );
});

describe('campaigns.pack contract', () => {
  it('rejects a numeric triggeredAt (AC #3)', () => {
    expect(
      isCampaignsPackContract({ ...validPack, triggeredAt: 12345 as unknown }),
    ).toBe(false);
  });

  it('rejects an empty campaignId', () => {
    expect(isCampaignsPackContract({ ...validPack, campaignId: '' })).toBe(
      false,
    );
  });

  it('AC #1 — accepts the canonical example payload verbatim', () => {
    expect(
      isCampaignsPackContract({
        campaignId: 'abc',
        triggeredAt: '2026-05-14T10:00:00Z',
        triggeredBy: 'schedule',
        correlationId: VALID_CORRELATION_ID,
      }),
    ).toBe(true);
  });

  it.each(['schedule', 'manual', 'recurrence'] as const)(
    'accepts triggeredBy=%s',
    (triggeredBy) => {
      expect(isCampaignsPackContract({ ...validPack, triggeredBy })).toBe(true);
    },
  );

  it('rejects a triggeredBy outside the PRD enum (e.g., workflow)', () => {
    expect(
      isCampaignsPackContract({
        ...validPack,
        triggeredBy: 'workflow' as unknown,
      }),
    ).toBe(false);
  });
});

describe('campaigns.send contract', () => {
  it('accepts an optional packKey when present', () => {
    expect(isCampaignsSendContract({ ...validSend, packKey: 'pack-1' })).toBe(
      true,
    );
  });

  it('rejects a non-positive page', () => {
    expect(isCampaignsSendContract({ ...validSend, page: 0 })).toBe(false);
    expect(isCampaignsSendContract({ ...validSend, page: -1 })).toBe(false);
  });

  it('rejects an empty contactIds array (producer should publish campaigns.tracked instead)', () => {
    expect(isCampaignsSendContract({ ...validSend, contactIds: [] })).toBe(
      false,
    );
  });

  it('rejects contactIds containing a non-string entry', () => {
    expect(
      isCampaignsSendContract({ ...validSend, contactIds: ['c1', 42] }),
    ).toBe(false);
  });

  it('rejects page > totalPages (producer bug)', () => {
    expect(
      isCampaignsSendContract({ ...validSend, page: 10, totalPages: 5 }),
    ).toBe(false);
  });

  it('accepts page === totalPages (last page)', () => {
    expect(
      isCampaignsSendContract({ ...validSend, page: 600, totalPages: 600 }),
    ).toBe(true);
  });

  it.each(['whatsapp', 'email', 'sms'] as const)(
    'accepts channelType=%s',
    (channelType) => {
      expect(isCampaignsSendContract({ ...validSend, channelType })).toBe(true);
    },
  );

  it('rejects a channelType outside the PRD enum (e.g., push)', () => {
    expect(
      isCampaignsSendContract({
        ...validSend,
        channelType: 'push' as unknown,
      }),
    ).toBe(false);
  });
});

describe('campaigns.tracked contract', () => {
  it('accepts completed=true for empty-audience case (page=0)', () => {
    expect(
      isCampaignsTrackedContract({
        ...validTracked,
        page: 0,
        sentCount: 0,
        failedCount: 0,
        completed: true,
      }),
    ).toBe(true);
  });

  it('rejects non-boolean completed', () => {
    expect(
      isCampaignsTrackedContract({
        ...validTracked,
        completed: 'yes' as unknown,
      }),
    ).toBe(false);
  });

  it('rejects negative sentCount', () => {
    expect(isCampaignsTrackedContract({ ...validTracked, sentCount: -1 })).toBe(
      false,
    );
  });
});

describe('campaigns.control contract', () => {
  it.each(['pause', 'stop', 'resume'] as const)(
    'accepts action=%s',
    (action) => {
      expect(isCampaignsControlContract({ ...validControl, action })).toBe(
        true,
      );
    },
  );

  it('rejects an action outside the whitelist', () => {
    expect(
      isCampaignsControlContract({
        ...validControl,
        action: 'archive' as unknown,
      }),
    ).toBe(false);
  });

  it('rejects mixed-case action (strict lowercase)', () => {
    expect(
      isCampaignsControlContract({
        ...validControl,
        action: 'Pause' as unknown,
      }),
    ).toBe(false);
  });
});

describe('events.received contract', () => {
  it.each(PLATFORMS)('accepts platform=%s', (platform) => {
    expect(isEventsReceivedContract({ ...validReceived, platform })).toBe(true);
  });

  it('rejects an unknown platform string', () => {
    expect(
      isEventsReceivedContract({
        ...validReceived,
        platform: 'postmark' as unknown,
      }),
    ).toBe(false);
  });

  it('rejects a non-UUID ingestionId', () => {
    expect(
      isEventsReceivedContract({ ...validReceived, ingestionId: 'not-uuid' }),
    ).toBe(false);
  });

  it('rejects a non-v4 UUID ingestionId (strict v4 per story 3.2)', () => {
    expect(
      isEventsReceivedContract({ ...validReceived, ingestionId: NON_V4_UUID }),
    ).toBe(false);
  });

  it('getEventsReceivedTopic builds the canonical topic string', () => {
    expect(getEventsReceivedTopic('evolution-api')).toBe(
      'events.received.evolution-api',
    );
    expect(getEventsReceivedTopic('unknown')).toBe('events.received.unknown');
  });

  it('isPlatform accepts whitelist values and rejects others', () => {
    expect(isPlatform('sendgrid')).toBe(true);
    expect(isPlatform('postmark')).toBe(false);
    expect(isPlatform('')).toBe(false);
  });
});

describe('events.enriched contract', () => {
  it('rejects a payload missing the enrichment block', () => {
    expect(isEventsEnrichedContract(omit(validEnriched, 'enrichment'))).toBe(
      false,
    );
  });

  it('rejects a payload with non-boolean enrichment.botMarkers.isBot', () => {
    expect(
      isEventsEnrichedContract({
        ...validEnriched,
        enrichment: {
          ...validEnriched.enrichment,
          botMarkers: { isBot: 'yes' as unknown, isDatacenter: false },
        },
      }),
    ).toBe(false);
  });

  it('rejects a payload missing contactId', () => {
    expect(isEventsEnrichedContract(omit(validEnriched, 'contactId'))).toBe(
      false,
    );
  });

  it('rejects a payload missing eventType', () => {
    expect(isEventsEnrichedContract(omit(validEnriched, 'eventType'))).toBe(
      false,
    );
  });

  it('accepts properties as an arbitrary key-value record', () => {
    expect(
      isEventsEnrichedContract({
        ...validEnriched,
        properties: {
          messageId: 'msg-2',
          retries: 3,
          tags: ['vip', 'us'],
          nested: { a: 1 },
        },
      }),
    ).toBe(true);
  });
});

describe('events.failed contract', () => {
  it('rejects a payload with non-integer attempts', () => {
    expect(isEventsFailedContract({ ...validFailed, attempts: 1.5 })).toBe(
      false,
    );
  });

  it('rejects negative attempts', () => {
    expect(isEventsFailedContract({ ...validFailed, attempts: -1 })).toBe(
      false,
    );
  });

  it('accepts a string originalPayload (raw webhook body kept as text)', () => {
    expect(
      isEventsFailedContract({
        ...validFailed,
        originalPayload: '{"raw":"text"}',
      }),
    ).toBe(true);
  });
});

describe('broker-topics', () => {
  it('BROKER_PUBLISH_TOPICS lists the 5 topics adapters publish/subscribe to (excludes events.enriched)', () => {
    expect(BROKER_PUBLISH_TOPICS).toEqual([
      CAMPAIGNS_PACK_TOPIC,
      CAMPAIGNS_SEND_TOPIC,
      CAMPAIGNS_TRACKED_TOPIC,
      CAMPAIGNS_CONTROL_TOPIC,
      EVENTS_FAILED_TOPIC,
    ]);
    expect(BROKER_PUBLISH_TOPICS).not.toContain(EVENTS_ENRICHED_TOPIC);
  });

  it('ALL_CONTRACT_TOPIC_NAMES includes events.enriched (in-process contract)', () => {
    expect(ALL_CONTRACT_TOPIC_NAMES).toContain(EVENTS_ENRICHED_TOPIC);
    expect(ALL_CONTRACT_TOPIC_NAMES).toHaveLength(6);
  });

  it('exposes adapter-specific wildcard patterns for events.received.<platform>', () => {
    expect(EVENTS_RECEIVED_TOPIC_PREFIX).toBe('events.received');
    expect(EVENTS_RECEIVED_RABBITMQ_BINDING).toBe('events.received.#');
    expect(
      EVENTS_RECEIVED_KAFKA_REGEX.test('events.received.evolution-api'),
    ).toBe(true);
    expect(EVENTS_RECEIVED_KAFKA_REGEX.test('events.received.sendgrid')).toBe(
      true,
    );
    expect(EVENTS_RECEIVED_KAFKA_REGEX.test('events.received.unknown')).toBe(
      true,
    );
    expect(EVENTS_RECEIVED_KAFKA_REGEX.test('events.enriched')).toBe(false);
    expect(
      EVENTS_RECEIVED_KAFKA_REGEX.test('events.received.evolution-api.extra'),
    ).toBe(false);
  });

  it('topic constants are literal strings (not enum members)', () => {
    expect(CAMPAIGNS_PACK_TOPIC).toBe('campaigns.pack');
    expect(CAMPAIGNS_SEND_TOPIC).toBe('campaigns.send');
    expect(CAMPAIGNS_TRACKED_TOPIC).toBe('campaigns.tracked');
    expect(CAMPAIGNS_CONTROL_TOPIC).toBe('campaigns.control');
    expect(EVENTS_ENRICHED_TOPIC).toBe('events.enriched');
    expect(EVENTS_FAILED_TOPIC).toBe('events.failed');
  });
});
