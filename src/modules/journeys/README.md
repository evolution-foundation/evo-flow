# Journeys module

## Journey-session state: where it lives (EVO-1645)

Journey sessions are held in the **shared cache layer**, not in process memory.

`JourneySessionCacheService` (`src/modules/cache/services/journey-session-cache.service.ts`)
extends the generic `BaseCacheService`, whose naming is inverted vs. the usual
convention:

| Layer in this codebase | What it is | Status for journey sessions |
|---|---|---|
| **L1** | **Redis** — shared across instances | always on |
| **L2** | in-memory LRU — local to the instance | **off** (`enableL2Cache: false`) |

Reads go **Redis → database**; writes go to **Redis** (sessions are not
persisted to Postgres by the normal flow). Keeping the local memory layer off
is deliberate: a per-instance LRU would serve stale session state if the
journey worker ever runs more than one replica.

## Seeding / driving sessions externally (E2E, QA)

Because the session store is shared, an external harness can seed a session
that a running worker will pick up. Two paths:

### 1. Redis (matches the normal runtime path)

Write the session JSON under the cache key and register it in the index set:

```bash
SESSION_ID=$(uuidgen)
redis-cli SET "evo-campaign:journey-session:$SESSION_ID" "$(cat <<JSON
{"id":"$SESSION_ID","journeyId":"<journey-uuid>","contactId":"<contact-uuid>",
 "status":"active","variables":{},"retryCount":0,"maxRetries":3,
 "executionLogs":[],"createdAt":"2026-01-01T00:00:00.000Z",
 "updatedAt":"2026-01-01T00:00:00.000Z","lastCached":"2026-01-01T00:00:00.000Z"}
JSON
)" EX 86400
redis-cli SADD "evo-campaign:journey-session:index" "$SESSION_ID"
```

The shape is `CachedJourneySession` (see the service file). The Temporal
workflow's first `updateJourneySession` resolves the session through
`get(sessionId)`, which reads this key. `workflowId`/`workflowRunId` can be
omitted when seeding — the runtime fills them in when the workflow starts.

### 2. Database row (survives a Redis flush)

Insert a row into `journey_sessions`; the cache's `get()` falls back to the
database on a Redis miss and re-caches the row. Useful when the harness has DB
access but no Redis access.

> Note: the runtime's session lifecycle (create, status updates) writes to
> Redis only (TTL 24h) — with one incidental exception: a session-variable
> update (`VariableInterpolationUtil.updateSessionVariables`) upserts the
> session as a `journey_sessions` row. So sessions that had variables updated
> survive a Redis flush; all others are dropped. That inconsistent durability
> story is out of scope here and left for a product decision.

Regression guards for these guarantees live in
`src/modules/cache/services/journey-session-cache.service.spec.ts`
(cross-instance sharing, DB-seeding fallback, `getMultiple` In() clause).

## Webhook entry points: which one actually runs

There is exactly one webhook path into a journey from this service:
`POST /api/v1/journeys/trigger/:journeyId` →
`JourneysService.processSpecificJourneyWebhookTrigger`. It requires
`contact_id` in the payload and starts the named journey **directly**: the
`webhook.journey_trigger` event it builds is handed to
`JourneySessionsService.startJourney` as the workflow's trigger payload. It is
never published to the `journey-triggers` bus and never goes through trigger
matching. The full contract — request body, auth, session semantics, and why
the Webhook trigger node consequently matches nothing on the bus — lives in
[`docs/journey-manual-trigger.md`](../../../docs/journey-manual-trigger.md);
keep that file the source of truth rather than restating it here.

`POST /webhooks/*` (the `event-receiver` / `event-process` runners) is the
e-mail deliverability path: detect platform, validate signature, enrich, write
to ClickHouse `contact_events`. It does not create contacts, does not talk to
the CRM, and does not start journeys — but it is not isolated from them.
`events_to_journey_triggers_mv` forwards **every** `contact_events` row to
`journey-triggers`, so provider callbacks do land on the journey bus as
`webhook.<platform>`. Two guards drop them at the far end: the empty
`contact_id` (`JourneyTriggerProcessor.isDispatchable`, CRM-271) and
`WebhookTrigger`'s exact-name match on `webhook.journey_trigger` (CRM-256).
Resolve a real contact for those rows and the name match is the only thing
left standing between deliverability traffic and every journey holding a
Webhook trigger.

This note exists because the module used to carry a `processWebhookTrigger`
method that built a full `webhook.received` event and never published it
anywhere. It was removed; reading it as "webhook ingestion works" cost real
analysis time more than once.
