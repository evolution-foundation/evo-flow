# Changelog

All notable changes to Evo Flow will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial public release of `evo-flow` as part of the Evo CRM Community family.
- Campaigns, journeys, segments, events, click-tracking and processing modules built on NestJS, Postgres, ClickHouse, Kafka, Redis and Temporal.
- Integration with `evo-auth-service-community` for token validation and with `evo-ai-crm-community` (Rails) as the source-of-truth for contacts, labels, users and custom attributes.
- Single-account architecture: no multi-tenancy at the evo-flow layer; account scoping is handled upstream by the CRM via JWT claims.
- Shared HTTP clients: `src/shared/crm-client/` (CRM Rails) and `src/shared/auth-client/` (evo-auth-service).

## Support

- **Issues**: [GitHub Issues](https://github.com/evolution-foundation/evo-flow/issues)
- **Security**: see [SECURITY.md](SECURITY.md)
- **Trademarks**: see [TRADEMARKS.md](TRADEMARKS.md)
