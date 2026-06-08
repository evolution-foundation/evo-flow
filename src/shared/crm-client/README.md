# CRM Client (`src/shared/crm-client`)

REST client for **evo-ai-crm-community** (Rails). Two layers:

- **`CrmClientService`** — the transport. Generic `get/post/patch/delete<T>()`
  used by the Q3 contacts/labels/custom-attributes consumers, plus legacy
  temporal-node domain methods (`assignAgent`, `sendMessage`, …).
- **`ContactsClientService` / `CustomAttributesClientService`** — thin domain
  facades over the generic methods. Their public interface is unchanged by the
  hardening below.

## Generic-path hardening (EVO-1205)

The generic `get/post/patch/delete` path is hardened for use inside the
distributed campaign pipeline (FR35, NFR31). The legacy temporal-node path
(`executeRequest` + domain methods) is **not** affected and keeps its 30s
budget.

### Timeout

- Per-request timeout: **5s** (`EVOAI_CRM_CLIENT_TIMEOUT_MS`, default `5000`).
- Overridable per call via `RequestOptions.timeoutMs`.
- Enforced with an `AbortController`; an abort is classified as a `timeout`.

### Retry policy

- **5xx, network errors and timeouts** are retried **3 times** with an explicit
  exponential backoff: **1s, 2s, 4s**
  (`EVOAI_CRM_CLIENT_RETRY_BACKOFF_MS`, default `1000,2000,4000`). The length of
  this schedule defines the retry count.
- **429** respects `Retry-After` when present, otherwise falls back to the
  backoff schedule.
- **4xx** (401, 404, 422, other client errors) are **never retried** — they
  propagate immediately:
  - `404` on GET → `null`; on a write → `NotFoundException`.
  - `401` → `UnauthorizedException`.
  - `422` / other 4xx → `BadRequestException`.

### Failure contract

When the retry budget is exhausted (or the circuit breaker is open), the
generic path throws **`ContactsClientUnavailableException`** — a `503`
(`extends ServiceUnavailableException`) carrying debug context:

| field            | meaning                                                        |
| ---------------- | -------------------------------------------------------------- |
| `correlationId`  | request correlation id (Story 2.5 `AsyncLocalStorage`/CLS)     |
| `endpoint`       | `METHOD /path` that failed                                     |
| `lastStatusCode` | last HTTP status seen (undefined for network/timeout/circuit)  |
| `totalLatencyMs` | wall-clock across all attempts + backoff                       |
| `reason`         | `server_error \| network \| timeout \| rate_limited \| circuit_open` |

Because it extends `ServiceUnavailableException`, existing callers that catch
`ServiceUnavailableException` keep working.

### SLA

Worst case for the generic path:

```
4 attempts × 5s timeout  +  (1s + 2s + 4s) backoff  ≈ 27s
```

Callers must budget for ~27s before a terminal `ContactsClientUnavailableException`.

### Fallback (caller responsibility)

The hardened client does **not** swallow terminal failures — it surfaces them.
The **campaign-packer** (Epic 4, EVO-1215) is the calling boundary and **must**:

1. `catch (ContactsClientUnavailableException)` around its contact-resolution
   calls, and
2. mark the campaign as **`Failed`**, recording the `correlationId` + `endpoint`
   from the exception as the failure reason for triage.

A campaign must never hang or be silently dropped because the CRM was briefly
unavailable — it fails loudly and traceably.

### Metrics

Prometheus counters on the default registry (scraped by `GET /metrics`):

| metric                                  | labels   | when                                             |
| --------------------------------------- | -------- | ------------------------------------------------ |
| `contacts_client_retry_total`           | `reason` | each retry (5xx/network/timeout/429)             |
| `contacts_client_timeout_total`         | —        | each attempt aborted by the 5s timeout           |
| `contacts_client_terminal_failure_total`| `reason` | each `ContactsClientUnavailableException` thrown |

## Environment variables

| var                              | default            | purpose                              |
| -------------------------------- | ------------------ | ------------------------------------ |
| `EVOAI_CRM_BASE_URL`             | `http://localhost:3000` | CRM base URL                    |
| `EVOAI_CRM_API_TOKEN`            | —                  | s2s `X-Service-Token` (required)     |
| `EVOAI_CRM_CLIENT_TIMEOUT_MS`    | `5000`             | generic-path per-request timeout     |
| `EVOAI_CRM_CLIENT_RETRY_BACKOFF_MS` | `1000,2000,4000` | generic-path retry backoff schedule  |
| `EVOAI_CRM_TIMEOUT_MS`           | `30000`            | legacy temporal-node path timeout    |
| `EVOAI_CRM_CIRCUIT_THRESHOLD`    | `5`                | circuit breaker failure threshold    |
| `EVOAI_CRM_CIRCUIT_RECOVERY_MS`  | `60000`            | circuit breaker recovery window      |
| `EVOAI_CRM_CACHE_TTL_MS`         | `30000`            | GET LRU cache TTL                     |
