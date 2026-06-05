# Manual Journey Trigger Contract

`POST /api/v1/journeys/trigger/:journeyId`

Starts a **specific** journey on demand for a contact. Unlike event-driven
journeys, this endpoint **targets the journey named in the URL directly** — it
does **not** go through trigger/event matching. (A `manual` trigger type has no
matching handler, so relying on event matching would never start the journey.)

## Auth

One of: `Authorization: Bearer <token>`, an API access token, or the
service-to-service integration key header `x-integration-api-key`.

## Request body

| Field        | Type   | Required | Description                                                        |
| ------------ | ------ | -------- | ------------------------------------------------------------------ |
| `contact_id` | string | yes      | Contact the journey runs for.                                      |
| `timestamp`  | string | no       | ISO-8601 event time. Defaults to now.                              |
| `data`       | object | no       | Arbitrary node inputs (see mapping below).                         |

```json
{
  "contact_id": "fe8f6a0e-9cf2-491b-85d4-dfb7af48249b",
  "data": { "conversation_id": "0dc78b7f-818f-41e2-9749-521dc696403b" }
}
```

## Payload → trigger event mapping

The fields under `data` are merged into the **top level** of the trigger
event's `properties`, matching what the real CRM emitter publishes
(`conversation_events_listener.rb`). The workflow reads node inputs from
`properties.conversation_id` (not `properties.data.conversation_id`), so pass
them under `data`:

```
data.conversation_id  ->  triggerEvent.properties.conversation_id
```

The emitted event uses `eventName: "webhook.journey_trigger"`,
`eventType: "track"`.

## Behavior

1. The journey must be `isActive` — otherwise `400`.
2. A journey **session is created** (persisted to cache) and the
   `journey-execution` Temporal workflow is started for it. The session is
   created **before** the workflow starts; the workflow's first
   `updateJourneySession` requires it to exist.
3. **One journey per contact at a time:** if the contact already has an
   `active`/`waiting` session, the trigger is rejected (`400`,
   `not started: contact_has_active_session`).

## Response

```json
{
  "success": true,
  "messageId": "f430e1b0-46e4-4bc3-96ee-c038431fbb54",
  "journeyId": "0bdab0df-87ef-4dc9-97a1-9ee4c5ed21b1",
  "contactId": "fe8f6a0e-9cf2-491b-85d4-dfb7af48249b",
  "processedAt": "2026-06-05T20:36:42.898Z"
}
```
