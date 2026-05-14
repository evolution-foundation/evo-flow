# Assignment Management Nodes

This directory contains Temporal activity nodes for managing agent and team assignments to conversations in EvoAI.

## Node Types

### AssignAgentNode
- **File**: `assign-agent.node.ts`
- **Purpose**: Assigns a specific agent to a conversation
- **Action**: Sets the responsible agent for handling the conversation
- **Configuration**:
  - `agent_id`: string (required)
  - `agent_name`: string (optional, for display)
- **Integration**: EvoAI CRM assignment API
- **Validation**: Agent must exist and be active in the account

### AssignTeamNode
- **File**: `assign-team.node.ts`
- **Purpose**: Assigns one or more teams to a conversation
- **Action**: Sets responsible team(s) for handling the conversation
- **Configuration**:
  - `team_ids`: string[] (required)
  - `team_names`: string[] (optional, for display)
  - `assignment_type`: 'primary' | 'secondary' (optional)
- **Integration**: EvoAI CRM assignment API
- **Validation**: Teams must exist and be active in the account

## Common Assignment Patterns

Both assignment nodes will:
1. Validate the conversation exists and is accessible
2. Verify agent/team exists and has proper permissions
3. Check for existing assignments and handle conflicts
4. Execute assignment via EvoAI API
5. Log assignment operation
6. Generate assignment variables for workflow

## Assignment Logic

### Agent Assignment
- **Single Agent**: Replaces any existing agent assignment
- **Conflict Resolution**: Previous agent assignment is replaced
- **Notification**: New agent receives assignment notification

### Team Assignment  
- **Multiple Teams**: Supports assigning multiple teams simultaneously
- **Assignment Types**: Primary teams get priority, secondary as backup
- **Load Balancing**: Integration with team workload distribution

## Error Handling

- **Agent/Team Not Found**: Graceful handling with warning
- **Permission Issues**: Clear error messages for access denied
- **Assignment Conflicts**: Configurable conflict resolution
- **API Failures**: Retry logic with proper error reporting

## Variables Generated

### Agent Assignment Variables:
- `agent_assigned`: boolean
- `assigned_agent_id`: string
- `assigned_agent_name`: string
- `assignment_timestamp`: ISO date string

### Team Assignment Variables:
- `teams_assigned`: boolean
- `assigned_team_ids`: string[]
- `assigned_team_names`: string[]
- `assignment_type`: string
- `assignment_timestamp`: ISO date string

## Integration Requirements

- **EvoAI CRM API**: Agent and team management endpoints
- **Notification System**: Alert agents/teams of new assignments
- **Audit Trail**: Track assignment history for reporting