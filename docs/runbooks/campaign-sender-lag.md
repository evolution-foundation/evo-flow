# Alert: CampaignSenderLagNotDraining

**Severity:** page · **Service:** `campaign-sender` · **Signal:** `evo_flow_consumer_lag{topic="campaigns.send"} > 0` sustained for 5m

## Symptom

The `campaigns.send` backlog has not drained for 5+ minutes: campaign batches are queued but the sender is not consuming them (or is consuming slower than the packer produces). User-visible effect: campaign progress stalls, `sent_contacts` counters stop moving.

## Probable causes (most likely first)

1. **Sender process down or not subscribed** — crashed replica, bad deploy, `RUN_MODE` misconfig.
2. **Rate limiter saturation** — dispatch volume above `RATE_LIMITER_CAPACITY`/`RATE_LIMITER_REFILL_RATE`; pages bounce with `rate-limited: requeued` (see also the EVO-1677 backstop: 3 redeliveries → `campaigns.send.dlq`).
3. **Provider slowness** — dispatch HTTP calls taking seconds each (check latency quantiles); throughput collapses without errors.
4. **Broker issue** — RabbitMQ/Kafka unhealthy, partition stuck.

## First commands

> **Blind spot:** if the sender PROCESS is dead, this alert goes silent (the
> lag series stops being scraped) — `EvoFlowTargetDown` is the alert that
> covers that case. If both fire, start from TargetDown.

```bash
# Is the sender alive and consuming? The sender logs via CustomLoggerService
# (plain text, not JSON) — grep, don't jq:
docker logs <sender-container> --since 10m | grep -E 'CampaignsSendConsumer|campaign.batch.processed' | tail -20

# Lag now, per topic:
curl -s localhost:3334/metrics | grep evo_flow_consumer_lag

# Rate-limited? Blocked acquires climbing means saturation, not an outage:
curl -s localhost:3334/metrics | grep evo_flow_rate_limit_blocks_total

# Dispatch latency p95 + error categories:
curl -s localhost:3334/metrics | grep -E 'evo_flow_request_duration_seconds|evo_flow_errors_total'

# Broker side (RabbitMQ UI): http://localhost:15672 → Queues → campaigns.send
# Anything dead-lettered already? campaigns.send.dlq depth.
```

## Escalate when

- The sender is up, not rate-limited, the provider is healthy and lag still grows → broker/infra issue, escalate to whoever owns the broker.
- Pages are landing in `campaigns.send.dlq` (delivery-limit exceeded) → escalate before replaying; replay needs coordination (see the event-process README for DLQ tooling patterns).
