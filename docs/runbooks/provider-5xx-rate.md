# Alert: ProviderDispatch5xxRateHigh

**Severity:** page · **Service:** `campaign-sender` · **Signal:** `dispatch_5xx` errors > 10% of all dispatch outcomes over 5m

## Symptom

More than 10% of campaign dispatches through the CRM inbox API are failing with provider 5xx. Affected contacts are marked `FAILED` (no retry until story 4.5 lands) — sustained 5xx burns campaign audience.

## Identifying the provider

The error counter has no provider label; identification comes from the sender logs — each failed dispatch logs `campaign contact failed` with `statusCode` and the campaign/contact ids, and the campaign's inbox determines the provider (Evolution API instance, email provider):

```bash
# Sender logs are plain text (CustomLoggerService), not JSON — grep, don't jq:
docker logs <sender-container> --since 10m | grep 'campaign contact failed' | tail -20
# → take campaignId from the log meta → CRM UI → campaign → inbox → channel/provider
```

## Probable causes (most likely first)

1. **Provider outage/degradation** — Evolution API instance down, email provider throttling into 5xx.
2. **CRM inbox API degraded** — the dispatch goes through the CRM; check CRM service health before blaming the end provider.
3. **One broken inbox skewing the ratio** — a single high-volume campaign on a misconfigured inbox.

## First commands

```bash
# Error mix — is it ONLY dispatch_5xx, or mixed with dispatch_network (CRM down)?
curl -s localhost:3334/metrics | grep 'evo_flow_errors_total{mode="campaign-sender"'

# CRM reachable? (routes.rb: GET /health/ready)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/health/ready

# Pause the affected campaign from the CRM UI to stop burning audience,
# then investigate the provider.
```

## Escalate when

- The provider is third-party and hard-down → escalate to the account owner of that provider; pause affected campaigns meanwhile.
- 5xx persists with the provider healthy → suspect the CRM inbox layer; escalate to the CRM on-call.
