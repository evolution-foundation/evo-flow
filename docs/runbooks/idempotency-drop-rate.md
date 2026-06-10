# Alert: EventProcessIdempotencyDropRateHigh

**Severity:** page · **Service:** `event-process` · **Signal:** idempotency hits > 50% of (hits + misses) over 5m, with traffic above the noise floor

## Symptom

More than half of incoming webhook events are being dropped as duplicates by the idempotency guard (SHA256 of rawPayload, 1h TTL — EVO-1204). **Possible replay attack or misconfig.** Legitimate traffic has a low duplicate rate (occasional provider redelivery); >50% sustained means something is re-sending the same payloads in volume.

## Probable causes (most likely first)

1. **Provider redelivery loop** — a provider not receiving timely 2xx from the receiver retries the same events (check `EventReceiver5xxRateHigh` — these two alerts firing together point here).
2. **Two intake paths for the same source** — duplicated webhook registration (e.g. the same Evolution instance pointing at two URLs that land on the same topic).
3. **Manual replay without stripping** — someone replaying `events.failed` payloads inside the 1h TTL window (they are silently dropped — see the event-process README reprocessing caveats).
4. **Replay attack** — an external actor re-posting captured payloads; signatures pass because the payload is authentic-but-old.

## First commands

```bash
# Drop ratio right now:
curl -s localhost:3334/metrics | grep -E 'idempotency_(hits|misses)_total'

# Who is sending duplicates? Receiver logs carry path + source IP:
docker logs <receiver-container> --since 10m \
  | jq -c 'select(.service=="event-receiver")' | tail -30

# Duplicates dropped per platform (event-process side):
curl -s localhost:3334/metrics | grep evo_webhook_event_duplicates_dropped_total

# Receiver failing 2xx (causing provider retries)?
curl -s localhost:3334/metrics | grep 'evo_flow_errors_total{mode="event-receiver"'
```

## Escalate when

- Source IPs in the receiver logs are unknown / not the configured providers → treat as a security incident (possible replay attack), escalate immediately.
- The duplicates come from a legitimate provider that keeps retrying → fix the 2xx path first (see event-receiver runbook); escalate to whoever owns the provider configuration if registration is duplicated.
