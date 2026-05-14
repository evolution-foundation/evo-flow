# Conversation Management Nodes

This directory contains Temporal activity nodes for managing conversation states and properties in EvoAI.

## Node Types

### MuteConversationNode
- **File**: `mute-conversation.node.ts`
- **Purpose**: Silences conversation notifications
- **Action**: Mutes conversation to stop generating notifications for agents
- **Configuration**: No additional parameters required
- **Integration**: EvoAI CRM conversation API

### DeferConversationNode
- **File**: `defer-conversation.node.ts`  
- **Purpose**: Defers conversation for a specified time period
- **Action**: Temporarily removes conversation from active list, auto-reactivates later
- **Configuration**: 
  - `snooze_type`: 'duration' | 'until_date'
  - `snooze_duration`: number (hours)
  - `snooze_until`: ISO date string
- **Integration**: EvoAI CRM conversation API

### ResolveConversationNode
- **File**: `resolve-conversation.node.ts`
- **Purpose**: Marks conversation as resolved and archives it
- **Action**: Sets conversation status to resolved, removes from active list
- **Configuration**: No additional parameters required
- **Integration**: EvoAI CRM conversation API

### ChangePriorityNode
- **File**: `change-priority.node.ts`
- **Purpose**: Changes conversation priority level
- **Action**: Updates conversation priority for proper queue ordering
- **Configuration**:
  - `priority`: 'low' | 'medium' | 'high' | 'urgent'
- **Integration**: EvoAI CRM conversation API

## Common Patterns

All conversation nodes will:
1. Validate conversation exists and is accessible
2. Check account permissions
3. Execute the conversation operation via EvoAI API
4. Log the operation result
5. Return success/failure with appropriate variables

## Error Handling

- **Conversation Not Found**: Graceful handling with warning log
- **Permission Denied**: Error result with clear message  
- **API Failure**: Retry logic with exponential backoff
- **Invalid Configuration**: Validation with descriptive errors

## Variables Generated

Each node generates execution variables:
- `conversation_operation_success`: boolean
- `conversation_id`: string
- `operation_timestamp`: ISO date string
- Node-specific variables as needed