<p align="center">
  <a href="https://evolutionfoundation.com.br">
    <img src="./public/hover-evolution.png" alt="Evolution Foundation" />
  </a>
</p>

<h1 align="center">Evo Flow</h1>

<p align="center">
  Backend NestJS para journeys, segments, campaigns, events e click-tracking — o motor de automacao da Evo CRM Community.
</p>

<p align="center">
  <a href="https://github.com/evolution-foundation/evo-flow/releases/latest"><img src="https://img.shields.io/github/v/release/evolution-foundation/evo-flow?include_prereleases&label=version&color=00ffa7" alt="Latest version" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache%202.0-blue.svg" alt="License: Apache 2.0" /></a>
  <a href="https://docs.evolutionfoundation.com.br"><img src="https://img.shields.io/badge/Docs-evolutionfoundation.com.br-00ffa7" alt="Documentation" /></a>
  <a href="https://evolutionfoundation.com.br/community"><img src="https://img.shields.io/badge/Community-Join%20us-white" alt="Community" /></a>
</p>

<p align="center">
  <a href="https://evolutionfoundation.com.br">Website</a> &middot;
  <a href="https://docs.evolutionfoundation.com.br">Documentation</a> &middot;
  <a href="https://evolutionfoundation.com.br/community">Community</a> &middot;
  <a href="mailto:suporte@evofoundation.com.br">Support</a>
</p>

---

## About

**Evo Flow** is the automation engine of the Evo CRM Community. Built on NestJS 11, it orchestrates journeys (via Temporal workflows), evaluates segments (on ClickHouse), schedules and executes campaigns, ingests events (via Kafka), and tracks short-link clicks.

It is designed as a stateless application service that integrates with the rest of the Evo CRM Community stack:
- **`evo-auth-service-community`** issues and validates Bearer tokens — Evo Flow does not perform login itself.
- **`evo-ai-crm-community`** is the source-of-truth for contacts, labels, users and custom attributes — Evo Flow reads through the CRM REST API.
- **Postgres** stores journeys, segments, campaigns and short-links definitions.
- **ClickHouse** stores high-volume event data and computes segment membership.
- **Kafka** is the queue backbone for event ingestion and campaign batches.
- **Redis** handles caching and short-term coordination.
- **Temporal** powers journey workflow orchestration.

## Part of the Evo CRM Community

Evo Flow is part of the [Evo CRM Community](https://github.com/evolution-foundation/evo-crm-community) ecosystem maintained by Evolution Foundation. To use the full stack, clone the umbrella repository with submodules:

```bash
git clone --recurse-submodules git@github.com:evolution-foundation/evo-crm-community.git
```

The Community Edition is **single-account** by design — no multi-tenancy at the application layer. Account scoping is handled upstream by `evo-auth-service-community` via JWT claims.

---

## Features

### Journeys
- Visual flow orchestration via [Temporal](https://temporal.io)
- 20+ action nodes (add label, send message, conditional, wait, webhook, etc.)
- Variable interpolation and environment manager
- Per-session execution tracking and bulk operations

### Segments
- ClickHouse-backed segment computation
- Distributed segment workers via Kafka
- Real-time and cron-based recomputation modes
- Contact-level segment membership queries

### Campaigns
- Audience computation against segments and direct lists
- Templates with statistics per variant (A/B winner selection)
- Schedule, pause, resume, stop, duplicate operations
- Execution status tracking

### Events
- Generic event ingestion (`track`, `identify`, `page`, `screen`)
- Channel-specific endpoints (`email`, `whatsapp`, `sms`, `web`, `batch`)
- ClickHouse-backed event search and aggregation

### Click Tracking
- Short-link generation with custom domains
- Click event capture with geo / UA enrichment
- DNS verification for custom domains

---

## Quick Start

### Prerequisites

- **Node.js** 22+
- **PostgreSQL** 15+
- **ClickHouse** 24+
- **Redis** 7+
- **Kafka** 3.7+ (with Zookeeper)
- **Temporal** 1.24+

### Installation

```bash
git clone git@github.com:evolution-foundation/evo-flow.git
cd evo-flow

# Install dependencies
npm install

# Configure environment (see .env.example)
cp .env.example .env

# Run database migrations
npm run migration:run

# Start in development mode
npm run dev
```

The service will be available at `http://localhost:3334`.

### API documentation

Once running, Swagger UI is available at:

```
http://localhost:3334/api
```

### Frozen event names

The `event` field on `POST /api/v1/events/track` and the optional `eventName` on `POST /api/v1/events/identify` must be one of the strings in [`src/modules/events/event-names.enum.ts`](./src/modules/events/event-names.enum.ts) (`EVENT_NAMES`). Other values return HTTP 400 from the global `ValidationPipe`. The list is the contract with the CRM publisher (`lib/events/evo_flow_event_names.rb` in `evo-ai-crm-community`); a CI script (`scripts/check-event-names-sync.sh` at the monorepo root) blocks PRs that diverge.

**Growing the list:** adding or removing an entry requires **three coordinated edits in the same PR**: the Ruby file, the TS file, and the `EXPECTED_COUNT` constant in `scripts/check-event-names-sync.sh`. Otherwise the sync job fails with `DIVERGENT — lists match each other but count is N (expected M)`.

---

## Configuration

Create a `.env` file (see `.env.example` for the complete list):

```bash
# Service
PORT=3334
RUN_MODE=single                 # single | api | event-worker | segment-worker | temporal-worker | campaign-worker

# Postgres (shared with evo-ai-crm-community)
POSTGRES_DB_HOST=localhost
POSTGRES_DB_PORT=5432
POSTGRES_DB_USERNAME=postgres
POSTGRES_DB_PASSWORD=postgres
POSTGRES_DB_DATABASE=evo_community

# ClickHouse
CLICKHOUSE_HOST=localhost
CLICKHOUSE_PORT=8123
CLICKHOUSE_DATABASE=evo_campaign
CLICKHOUSE_USERNAME=default
CLICKHOUSE_PASSWORD=

# Kafka
KAFKA_BROKERS=localhost:9092

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Temporal
TEMPORAL_ADDRESS=localhost:7233

# Upstream services
EVO_AUTH_SERVICE_URL=http://localhost:3001
EVO_AUTH_VALIDATE_TOKEN_ENDPOINT=/api/v1/auth/validate
EVOAI_CRM_BASE_URL=http://localhost:3000
EVOAI_CRM_API_TOKEN=<service-to-service-token>
AUTH_APIKEY_INTEGRATION_LOCAL=<service-to-service-token>
```

---

## Run Modes

Evo Flow can run as a single process (all-in-one for development) or as separate workers (recommended for production):

```bash
npm run dev:single      # everything in one process (default for local dev)
npm run dev:api         # HTTP API only
npm run dev:event       # event worker (Kafka consumer)
npm run dev:segment     # segment worker (ClickHouse computation)
npm run dev:temporal    # Temporal worker (journey workflows)
npm run dev:campaign    # campaign worker (audience + sender)
```

---

## Architecture

Evo Flow is the automation layer between the user-facing Evo CRM and the underlying data plane:

```
                       ┌──────────────────────────────┐
                       │  evo-ai-frontend-community   │
                       │  (React + Vite SPA)          │
                       └────────────┬─────────────────┘
                                    │ Bearer token (issued by evo-auth)
                ┌───────────────────┼───────────────────┐
                ↓                   ↓                   ↓
   evo-ai-crm-community     Evo Flow (you)     evo-auth-service-community
   (Rails, source-of-truth  (NestJS, journeys, (Rails, token issuance,
    for contacts/labels)    segments, events)  RBAC, MFA)
                │                   │
                │                   ├─→ Postgres (journeys/segments/campaigns)
                │                   ├─→ ClickHouse (events, segment state)
                │                   ├─→ Kafka (event bus, campaign batches)
                │                   ├─→ Redis (cache, throttling)
                │                   └─→ Temporal (workflow orchestration)
                ↓
            (REST reads)
```

Inter-service authentication uses Bearer tokens issued by `evo-auth-service-community`. Service-to-service calls use the `EVOAI_CRM_API_TOKEN` API key. No `account-id` header is required — account scoping is derived from JWT claims at the auth boundary.

---

## Key Endpoints

| Endpoint | Description |
|---|---|
| `POST /api/v1/events/track` | Generic event ingestion |
| `POST /api/v1/events/{email,whatsapp,sms,web,batch}` | Channel-specific event endpoints |
| `GET /api/v1/segments` | List / create segments |
| `POST /api/v1/segments/:id/recompute` | Trigger segment recomputation |
| `GET /api/v1/segments/:id/contact-ids` | List contact ids in a segment |
| `GET /api/v1/journeys` | List / create journeys |
| `POST /api/v1/journeys/:id/toggle-active` | Activate / deactivate journey |
| `POST /api/v1/journeys/trigger/:journeyId` | Manual journey trigger |
| `GET /api/v1/campaigns` | List / create campaigns |
| `POST /api/v1/campaigns/:id/execute` | Start campaign execution |
| `GET /link/:shortCode` | Public redirect (click tracking) |

---

## Testing

```bash
# All tests
npm test

# Specific file
npm test -- src/modules/segments/segments.service.spec.ts

# With coverage
npm run test:cov
```

---

## Documentation

| Resource | Link |
|---|---|
| Website | [evolutionfoundation.com.br](https://evolutionfoundation.com.br) |
| Documentation | [docs.evolutionfoundation.com.br](https://docs.evolutionfoundation.com.br) |
| Community | [evolutionfoundation.com.br/community](https://evolutionfoundation.com.br/community) |
| Changelog | [CHANGELOG.md](./CHANGELOG.md) |
| Contributing | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Security | [SECURITY.md](./SECURITY.md) |

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines on how to submit issues, propose features, and open pull requests.

Join our [community](https://evolutionfoundation.com.br/community) to discuss ideas and collaborate.

---

## Security

For security issues, **do not open a public issue**. Email **suporte@evofoundation.com.br** or use GitHub's private vulnerability reporting. See [SECURITY.md](./SECURITY.md) for details.

---

## Acknowledgments

Evo Flow builds on excellent open-source software:
- [NestJS](https://nestjs.com) — application framework
- [Temporal](https://temporal.io) — workflow orchestration
- [ClickHouse](https://clickhouse.com) — analytics database
- [KafkaJS](https://kafka.js.org) — Kafka client
- [TypeORM](https://typeorm.io) — ORM
- [Doorkeeper](https://github.com/doorkeeper-gem/doorkeeper) (via `evo-auth-service-community`) — OAuth 2.0

---

## License

Evo Flow is licensed under the Apache License 2.0. See [LICENSE](./LICENSE) for details.

## Trademarks

"Evolution Foundation", "Evolution" and "Evo Flow" are trademarks of Evolution Foundation. See [TRADEMARKS.md](./TRADEMARKS.md) for the brand assets policy.

Third-party attributions are documented in [NOTICE](./NOTICE).

---

<p align="center">
  Made by <a href="https://evolutionfoundation.com.br">Evolution Foundation</a> · © 2026
</p>
