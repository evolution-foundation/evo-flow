import * as fs from 'fs';
import * as path from 'path';

// Coverage guard (EVO-1634): the Customer Journey palette
// (evo-ai-frontend-community JourneyFlowEditor `nodeTypes`) can emit these
// action node types. Each MUST have an explicit `case` in the executor switch,
// otherwise it falls into `default:` and silently no-ops at runtime.
//
// Keep this list in sync with the frontend palette. A new palette node added
// without an executor case will turn this test red instead of shipping inert.
const WIRED_ACTION_NODE_TYPES = [
  'send-message-node',
  'send-canned-response-node',
  'send-transcript-node',
  'assign-agent-node',
  'assign-team-node',
  'assign-bot-node',
  'add-label-node',
  'remove-label-node',
  'update-contact-node',
  'update-custom-attribute-node',
  'set-variable-node',
  'mute-conversation-node',
  'resolve-conversation-node',
  'snooze-conversation-node',
  'defer-conversation-node',
  'change-priority-node',
];

// Known-unwired palette nodes deferred to EVO-1634 Phase 2 (need a new CRM
// client method / endpoint). Tracked on the card; listed here so they are not
// silently forgotten. When wired, move them into WIRED_ACTION_NODE_TYPES.
const KNOWN_UNWIRED_PHASE_2 = [
  'assign-to-pipeline-node',
  'send-email-team-node',
];

describe('Journey executor node coverage (EVO-1634)', () => {
  const workflowSrc = fs.readFileSync(
    path.join(__dirname, 'journey-execution.workflow.ts'),
    'utf8',
  );

  it.each(WIRED_ACTION_NODE_TYPES)(
    'has a non-default executor case for %s',
    (nodeType) => {
      expect(workflowSrc).toContain(`case '${nodeType}':`);
    },
  );

  it('documents the Phase 2 nodes that are still unwired', () => {
    expect(KNOWN_UNWIRED_PHASE_2.length).toBeGreaterThan(0);
  });
});
