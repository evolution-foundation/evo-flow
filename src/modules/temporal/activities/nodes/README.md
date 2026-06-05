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
6. **Manifest** — add the node type to the frontend manifest
   `evo-ai-frontend-community/src/pages/Customer/Journey/journey-node-manifest.json`
   (it is added there automatically as part of building the palette node; its
   own `journey-node-manifest.spec.ts` keeps it in sync with `nodeTypes`).

## Frontend ↔ executor parity

The palette source of truth is the frontend manifest
`evo-ai-frontend-community/.../journey-node-manifest.json` (kept honest against
`JourneyFlowEditor.tsx` `nodeTypes` by its own spec). The executor coverage guard
`workflows/journey-execution.coverage.spec.ts` reads that manifest and asserts
every palette node type has a `case` here — so a palette node shipped without an
executor turns the guard red instead of shipping inert.

CI caveat: evo-flow CI (Sourcery) does not check out the frontend repo, so when
the sibling manifest is absent the guard degrades to a documented skip; the real
parity check runs in the monorepo checkout / locally.
