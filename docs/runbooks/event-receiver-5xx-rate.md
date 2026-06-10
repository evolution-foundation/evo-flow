# Alert: EventReceiver5xxRateHigh

**Severity:** page · **Service:** `event-receiver` · **Signal:** 5xx categories (`intake_failure` 503 + `unhandled` 500) > 1% of requests over 5m

## Symptom

The webhook receiver is failing more than 1% of provider deliveries with 5xx. Providers back off (the 503 carries `Retry-After: 10`) and may eventually drop deliveries — event loss for tracking. Note: `malformed_payload` is a 400 and does NOT count toward this alert.

## Probable causes (most likely first)

1. **Broker unavailable** (`intake_failure`, 503) — the receiver acks only after publishing to `events.received.<platform>`; RabbitMQ/Kafka down turns every webhook into a 503.
2. **Unhandled exception** (`unhandled`, 500) — a payload shape or code path blowing up before intake; look for stack traces.
3. **Resource exhaustion** — receiver process up but degraded (event loop blocked, OOM-restarting).

## First commands

```bash
# Which category dominates? intake_failure → broker; unhandled → code path.
curl -s localhost:3334/metrics | grep 'evo_flow_errors_total{mode="event-receiver"'

# Logs filtered by service (= RUN_MODE), errors only:
docker logs <receiver-container> --since 10m \
  | jq -c 'select(.service=="event-receiver") | select(.level=="error")' | tail -20

# Broker health:
# RabbitMQ UI http://localhost:15672 (or kcat -b localhost:9092 -L for Kafka)
docker ps --filter name=rabbitmq --filter name=kafka

# Receiver process alive and answering? (do NOT probe with a fake webhook —
# that publishes a real envelope to the broker)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3334/metrics
```

## Escalate when

- Broker is down and not recovering with a container restart → escalate to infra; webhook deliveries are being refused while it's down (providers retry, but not forever).
- `unhandled` spikes after a deploy → roll back first, debug after; escalate to the author of the deploy if rollback is not clean.
