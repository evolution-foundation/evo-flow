import {
  CAMPAIGNS_CONTROL_TOPIC,
  CAMPAIGNS_PACK_TOPIC,
  CAMPAIGNS_SEND_TOPIC,
  CAMPAIGNS_TRACKED_TOPIC,
  EVENTS_ENRICHED_TOPIC,
  EVENTS_FAILED_TOPIC,
  EVENTS_RECEIVED_TOPIC_PATTERN,
  EVENTS_RECEIVED_TOPIC_PREFIX,
  PLATFORMS,
  STATIC_BROKER_TOPICS,
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
const VALID_INGESTION_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VALID_ISO = '2026-05-14T10:00:00.000Z';

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
  ...validReceived,
  ua: {
    browser: { name: 'Chrome', version: '90.0.1' },
    os: { name: 'iOS', version: '14.0' },
    device: { type: 'mobile', vendor: 'Apple', model: 'iPhone' },
  },
  geo: { country: 'US', region: 'CA', city: 'San Francisco' },
  botMarkers: { isBot: false, isDatacenter: false },
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
      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-and-drop pattern
      const { correlationId: _drop, ...withoutCorrelation } = valid;
      expect(guard(withoutCorrelation)).toBe(false);
    },
  );

  it.each(ALL_CONTRACTS)(
    '%s rejects a payload with a non-UUID correlationId',
    (_label, guard, valid) => {
      expect(guard({ ...valid, correlationId: 'not-a-uuid' })).toBe(false);
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
});

describe('campaigns.send contract', () => {
  it('accepts an optional packKey when present', () => {
    expect(isCampaignsSendContract({ ...validSend, packKey: 'pack-1' })).toBe(
      true,
    );
  });

  it('rejects a negative page', () => {
    expect(isCampaignsSendContract({ ...validSend, page: -1 })).toBe(false);
  });

  it('rejects contactIds containing a non-string entry', () => {
    expect(
      isCampaignsSendContract({ ...validSend, contactIds: ['c1', 42] }),
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
  it('rejects a payload missing the ua block', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-and-drop pattern
    const { ua: _drop, ...withoutUa } = validEnriched;
    expect(isEventsEnrichedContract(withoutUa)).toBe(false);
  });

  it('rejects a payload with non-boolean botMarkers.isBot', () => {
    expect(
      isEventsEnrichedContract({
        ...validEnriched,
        botMarkers: { isBot: 'yes' as unknown, isDatacenter: false },
      }),
    ).toBe(false);
  });

  it('inherits envelope validation (rejects missing platform)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructure-and-drop pattern
    const { platform: _drop, ...withoutPlatform } = validEnriched;
    expect(isEventsEnrichedContract(withoutPlatform)).toBe(false);
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

describe('broker-topics union', () => {
  it('STATIC_BROKER_TOPICS contains exactly the 6 fixed topic names', () => {
    expect(STATIC_BROKER_TOPICS).toEqual([
      CAMPAIGNS_PACK_TOPIC,
      CAMPAIGNS_SEND_TOPIC,
      CAMPAIGNS_TRACKED_TOPIC,
      CAMPAIGNS_CONTROL_TOPIC,
      EVENTS_ENRICHED_TOPIC,
      EVENTS_FAILED_TOPIC,
    ]);
  });

  it('exposes the wildcard pattern for events.received.<platform>', () => {
    expect(EVENTS_RECEIVED_TOPIC_PATTERN).toBe('events.received.*');
    expect(EVENTS_RECEIVED_TOPIC_PREFIX).toBe('events.received');
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
