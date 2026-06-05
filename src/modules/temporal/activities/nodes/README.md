# Journey action nodes (evo-flow executor)

The Customer Journey canvas (`/journey/:id/flow`) executes on this Temporal
worker. Each action node the frontend palette can emit MUST be wired here, or it
falls into the `journey-execution.workflow.ts` `default:` branch and silently
no-ops at runtime (see EVO-1634).

## How to add a new action node

Mirror an existing node (e.g. `evoai/communication/send-message.node.ts` for a
node that calls the CRM, or `evoai/conversation/snooze-conversation.node.ts` for
a conversation status change):

1. **Node** — create `evoai/<category>/<node>.node.ts` extending `BaseNode`:
   - `super('<node>')` in the constructor,
   - a `<Node>Input` interface (`nodeId`, the ids it needs, `nodeData`),
   - `execute()` that calls a `CrmClientService` method and returns
     `createSuccessResult()` / `createErrorResult()`.
2. **CRM client** — if the effect needs a CRM endpoint not yet covered, add a
   method to `src/shared/crm-client/crm-client.service.ts` (mirror `sendMessage`
   / `getInboxes`).
3. **Activity** — in `activities/action-nodes.activities.ts` add: the import, the
   `*NodeInput` re-export, the `ActionNodeActivities` interface entry, the lazy
   getter, and the `execute<Node>Node` implementation.
4. **Workflow case** — add `case '<node>-node':` in
   `workflows/journey-execution.workflow.ts` calling the activity (extract
   `conversation_id` from `input.triggerEvent?.properties`).
5. **Index** — export the node from its category `index.ts`.
6. **Coverage guard** — add the node type to `WIRED_ACTION_NODE_TYPES` in
   `workflows/journey-execution.coverage.spec.ts` so a future regression turns
   the test red.

## Frontend ↔ executor parity

The palette source of truth is `evo-ai-frontend-community`
`src/pages/Customer/Journey/JourneyFlowEditor.tsx` (`nodeTypes`). The coverage
guard asserts every wired type has a `case`; nodes still pending an executor are
listed in `KNOWN_UNWIRED_PHASE_2` there.
