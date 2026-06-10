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
