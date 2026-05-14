# EvoAI CRM Temporal Nodes

This directory contains Temporal activity nodes for integrating with the EvoAI CRM platform. These nodes enable campaign workflows to interact with conversations, agents, and teams within the CRM system.

## Overview

The EvoAI CRM nodes provide seamless integration between Temporal workflows and the EvoAI CRM platform, allowing campaigns to:

- **Assign conversations** to agents and teams
- **Send messages** and email transcripts
- **Manage conversation state** (mute, resolve, snooze)
- **Change conversation priority** levels

## Authentication

All nodes use **Service Token Authentication** for secure communication with the CRM API.

### Required Environment Variables

```bash
# EvoAI CRM API Configuration
EVOAI_CRM_API_TOKEN=your_secure_service_token_here
EVO_AI_CRM_URL=https://crm-api.evoai.com

# For development
# EVO_AI_CRM_URL=http://localhost:3000
```

### Token Requirements

- **Length**: Minimum 32 characters
- **Generation**: Use `openssl rand -hex 32` or equivalent
- **Security**: Different tokens per environment (dev, staging, production)
- **Headers**: Sent as `X-Service-Token` header

## Directory Structure

### `/assignment` - Assignment Management Nodes
- **assign-agent.node.ts**: Assigns conversation to specific agent
- **assign-team.node.ts**: Assigns conversation to team

### `/communication` - Communication Nodes
- **send-message.node.ts**: Sends messages in conversations
- **send-transcript.node.ts**: Sends conversation transcript via email

### `/conversation` - Conversation Management Nodes
- **mute-conversation.node.ts**: Mutes conversation notifications
- **resolve-conversation.node.ts**: Marks conversation as resolved
- **snooze-conversation.node.ts**: Snoozes conversation for later
- **change-priority.node.ts**: Changes conversation priority level

## Base Architecture

All EvoAI nodes extend the `BaseNode` class and use the `EvoAICRMBaseService` for API communication.

### Common Features:
- **Service Token Authentication**: Secure API communication with CRM
- **Variable Interpolation**: Support for dynamic variables in node data
- **Error Handling**: Retry logic, rate limiting, circuit breaker patterns
- **Structured Logging**: Execution timing and detailed operation logs
- **Response Standardization**: Consistent NodeExecutionResult format

## CRM API Mapping

| Node | CRM Endpoint | Method |
|------|--------------|---------|
| AssignAgentNode | `/assignments` | POST |
| AssignTeamNode | `/assignments` | POST |
| SendMessageNode | `/messages` | POST |
| SendTranscriptNode | `/transcript` | POST |
| MuteConversationNode | `/mute` | POST |
| ResolveConversationNode | `/toggle_status` | POST |
| SnoozeConversationNode | `/toggle_status` | POST |
| ChangePriorityNode | `/toggle_priority` | POST |

Base URL pattern: `/api/v1/accounts/{accountId}/conversations/{conversationId}`

## Usage Example

```typescript
import { AssignAgentNode } from '../activities/nodes';

const assignAgentActivity = proxyActivities<AssignAgentNode>({
  startToCloseTimeout: '30s',
  retry: { maximumAttempts: 3 }
});

const result = await assignAgentActivity.execute({
  nodeId: 'assign-agent-1',
  conversationId: 'conv_123',
  accountId: 'acc_456',
  sessionId: 'session_789',
  nodeData: {
    agent_id: 'agent_123',
    agent_name: 'John Doe'
  }
});
```

## Error Handling

### HTTP Status Codes
- **401**: Service token authentication failed
- **403**: Insufficient permissions
- **404**: Conversation/account not found
- **422**: Validation error
- **429**: Rate limited (automatic retry)

### Retry Strategy
- **Max retries**: 3 attempts
- **Backoff**: Exponential (1s, 2s, 4s)
- **Rate limits**: Respects Retry-After header
- **Circuit breaker**: Stops for auth/validation errors

## Development & Testing

### Environment Setup
1. Set `EVOAI_CRM_API_TOKEN` and `EVO_AI_CRM_URL`
2. Ensure network connectivity to CRM instance
3. Verify service token permissions

### Testing
```bash
# Test service token
curl -H "X-Service-Token: $EVOAI_CRM_API_TOKEN" \
     "$EVO_AI_CRM_URL/api/v1/internal/service_tokens/validate"
```

## Security Considerations

1. **Token Storage**: Secure environment variables only
2. **Network Security**: HTTPS in production
3. **Access Control**: Limited token permissions
4. **Monitoring**: Track authentication failures
5. **Token Rotation**: Regular rotation (90 days)

For detailed usage instructions, see individual node files and the complete API documentation in `AUTOMATION_ANALYSIS.md`.