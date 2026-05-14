# EvoAI CRM Automation System Analysis

## Overview

Este documento analisa como o sistema de automation_rules do EvoAI CRM executa diferentes tipos de nodes/ações, fornecendo a base para implementar a mesma funcionalidade via API calls nos nossos Temporal nodes.

O sistema de automação do EvoAI CRM suporta dois modos:
- **Simple Mode**: Lista linear de ações (legacy)
- **Flow Mode**: Sistema visual baseado em nodes com branching condicional

## Arquitetura do Sistema

### 1. Database Models

#### AutomationRule Model
**Arquivo**: `/app/models/automation_rule.rb`

```ruby
# Schema Principal
- actions: JSONB        # Lista de ações (simple mode)
- conditions: JSONB     # Condições de trigger
- flow_data: JSONB      # Dados do flow visual (flow mode)
- mode: string          # 'simple' ou 'flow'
- event_name: string    # Tipo de evento trigger

# Ações Suportadas
ACTIONS = %w[
  assign_agent assign_team send_message send_email_to_team 
  send_email_transcript mute_conversation snooze_conversation 
  resolve_conversation change_priority add_label remove_label
  send_webhook update_contact
].freeze

# Event Types
conversation_created, conversation_updated, message_created,
pipeline_stage_updated, contact_created, contact_updated
```

#### Conversation Model
```ruby
# Status Enum
enum status: { open: 0, resolved: 1, pending: 2, snoozed: 3 }

# Priority Enum  
enum priority: { low: 0, medium: 1, high: 2, urgent: 3 }

# Key Fields
assignee_id, team_id, status, priority, inbox_id, contact_id
```

### 2. Core Action Service

**Arquivo**: `/app/services/action_service.rb`

```ruby
class ActionService
  # === CONVERSATION STATE MANAGEMENT ===
  
  def mute_conversation(_params)
    @conversation.mute!
  end

  def snooze_conversation(_params) 
    @conversation.snoozed!
  end

  def resolve_conversation(_params)
    @conversation.resolved!
  end

  def change_priority(priority)
    @conversation.update!(priority: (priority[0] == 'nil' ? nil : priority[0]))
  end

  # === ASSIGNMENT ACTIONS ===
  
  def assign_agent(agent_ids = [])
    return @conversation.update!(assignee_id: nil) if agent_ids[0] == 'nil'
    return unless agent_belongs_to_inbox?(agent_ids)
    
    @agent = @account.users.find_by(id: agent_ids)
    @conversation.update!(assignee_id: @agent.id) if @agent.present?
  end

  def assign_team(team_ids = [])
    should_unassign = team_ids.blank? || %w[nil 0].include?(team_ids[0].to_s)
    return @conversation.update!(team_id: nil) if should_unassign
    return unless team_belongs_to_account?(team_ids)
    
    @conversation.update!(team_id: team_ids[0])
  end

  # === EMAIL ACTIONS ===
  
  def send_email_transcript(emails)
    emails = emails[0].gsub(/\s+/, '').split(',')
    emails.each do |email|
      email = parse_email_variables(@conversation, email)
      ConversationReplyMailer.with(account: @conversation.account)
        .conversation_transcript(@conversation, email)&.deliver_later
    end
  end
end
```

### 3. Automation Rules Action Service

**Arquivo**: `/app/services/automation_rules/action_service.rb`

```ruby
def send_message(message)
  return if conversation_a_tweet?
  
  params = { 
    content: message[0], 
    private: false, 
    content_attributes: { automation_rule_id: @rule.id } 
  }
  Messages::MessageBuilder.new(nil, @conversation, params).perform
end

def send_email_to_team(params)
  teams = Team.where(id: params[0][:team_ids])
  teams.each do |team|
    TeamNotifications::AutomationNotificationMailer
      .conversation_creation(@conversation, team, params[0][:message])&.deliver_now
  end
end
```

## API Endpoints Mapeados

### Base URL Pattern
```
/api/v1/accounts/{account_id}/conversations/{conversation_id}
```

### Endpoints por Ação

| Ação | Method | Endpoint | Payload Example |
|------|---------|----------|----------------|
| **Assign Agent** | POST | `/assignments` | `{"assignee_id": "123"}` |
| **Assign Team** | POST | `/assignments` | `{"team_id": "456"}` |
| **Send Message** | POST | `/messages` | `{"content": "Hello", "private": false}` |
| **Send Transcript** | POST | `/transcript` | `{"email": "user@example.com"}` |
| **Mute Conversation** | POST | `/mute` | `{}` |
| **Resolve Conversation** | POST | `/toggle_status` | `{"status": "resolved"}` |
| **Snooze Conversation** | POST | `/toggle_status` | `{"status": "snoozed"}` |
| **Change Priority** | POST | `/toggle_priority` | `{"priority": "high"}` |

### Endpoints Especiais

```ruby
# Send Email to Team - Não tem endpoint direto
# Usa: TeamNotifications::AutomationNotificationMailer
# Precisará de endpoint customizado ou webhook
```

## Flow Execution Logic

**Arquivo**: `/app/services/automation_rules/flow_execution_service.rb`

### Processamento de Flow:

1. **Find Trigger Node**: Localiza o `trigger-node` no flow
2. **Recursive Execution**: Segue edges de node para node  
3. **Action Node Processing**: Executa ação específica baseada no node type
4. **Loop Prevention**: Usa tracking de visitados e depth limits

### Node Types Suportados:
```ruby
action_node_types = %w[
  assign-agent-node
  assign-team-node  
  add-label-node
  remove-label-node
  send-message-node
  send-attachment-node
  send-email-team-node
  send-transcript-node
  send-webhook-node
  mute-conversation-node
  snooze-conversation-node
  resolve-conversation-node
  change-priority-node
]
```

## Implementação para Temporal Nodes

### 1. Base HTTP Service

```typescript
// base-crm.service.ts
export class EvoAICRMService {
  private baseURL: string;
  private apiToken: string;

  constructor() {
    this.baseURL = process.env.EVOAI_CRM_BASE_URL;
    this.apiToken = process.env.EVOAI_CRM_API_TOKEN;
  }

  private getHeaders(accountId: string) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiToken}`,
      'X-Account-ID': accountId
    };
  }

  private getConversationURL(accountId: string, conversationId: string) {
    return `${this.baseURL}/api/v1/accounts/${accountId}/conversations/${conversationId}`;
  }
}
```

### 2. Conversation Management Nodes

```typescript
// conversation/mute-conversation.node.ts
export class MuteConversationNode extends BaseNode {
  constructor() {
    super('mute-conversation');
  }

  async execute(input: any): Promise<NodeExecutionResult> {
    const { conversationId, accountId } = input;

    return await this.executeWithTiming(input.nodeId, input, async () => {
      const response = await fetch(
        `${this.getConversationURL(accountId, conversationId)}/mute`,
        {
          method: 'POST',
          headers: this.getHeaders(accountId)
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to mute conversation: ${response.statusText}`);
      }

      return this.createSuccessResult(input, Date.now() - startTime, {
        conversation_muted: true,
        mute_timestamp: new Date().toISOString()
      });
    });
  }
}
```

### 3. Assignment Nodes

```typescript
// assignment/assign-agent.node.ts
export class AssignAgentNode extends BaseNode {
  constructor() {
    super('assign-agent');
  }

  async execute(input: any): Promise<NodeExecutionResult> {
    const { conversationId, accountId, nodeData } = input;
    const { agent_id } = nodeData;

    return await this.executeWithTiming(input.nodeId, input, async () => {
      const response = await fetch(
        `${this.getConversationURL(accountId, conversationId)}/assignments`,
        {
          method: 'POST',
          headers: this.getHeaders(accountId),
          body: JSON.stringify({
            assignee_id: agent_id || null
          })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to assign agent: ${response.statusText}`);
      }

      return this.createSuccessResult(input, Date.now() - startTime, {
        agent_assigned: true,
        assigned_agent_id: agent_id,
        assignment_timestamp: new Date().toISOString()
      });
    });
  }
}
```

### 4. Communication Nodes

```typescript
// communication/send-message.node.ts
export class SendMessageNode extends BaseNode {
  constructor() {
    super('send-message');
  }

  async execute(input: any): Promise<NodeExecutionResult> {
    const { conversationId, accountId, nodeData } = input;
    const interpolatedData = await this.interpolateNodeData(input, nodeData);
    const { message_content, private: isPrivate = false } = interpolatedData;

    return await this.executeWithTiming(input.nodeId, input, async () => {
      const response = await fetch(
        `${this.getConversationURL(accountId, conversationId)}/messages`,
        {
          method: 'POST',
          headers: this.getHeaders(accountId),
          body: JSON.stringify({
            content: message_content,
            private: isPrivate
          })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to send message: ${response.statusText}`);
      }

      const result = await response.json();

      return this.createSuccessResult(input, Date.now() - startTime, {
        message_sent: true,
        message_id: result.id,
        send_timestamp: new Date().toISOString()
      });
    });
  }
}
```

### 5. Email Transcript Node

```typescript
// communication/send-transcript.node.ts
export class SendTranscriptNode extends BaseNode {
  constructor() {
    super('send-transcript');
  }

  async execute(input: any): Promise<NodeExecutionResult> {
    const { conversationId, accountId, nodeData } = input;
    const interpolatedData = await this.interpolateNodeData(input, nodeData);
    const { recipient_email } = interpolatedData;

    return await this.executeWithTiming(input.nodeId, input, async () => {
      const response = await fetch(
        `${this.getConversationURL(accountId, conversationId)}/transcript`,
        {
          method: 'POST',
          headers: this.getHeaders(accountId),
          body: JSON.stringify({
            email: recipient_email
          })
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to send transcript: ${response.statusText}`);
      }

      return this.createSuccessResult(input, Date.now() - startTime, {
        transcript_sent: true,
        recipient_email,
        send_timestamp: new Date().toISOString()
      });
    });
  }
}
```

## Error Handling Patterns

### CRM Pattern:
```ruby
begin
  send(action[:action_name], action[:action_params])
rescue StandardError => e
  Rails.logger.error "Automation Rule #{@rule.id}: Error executing action #{action[:action_name]}: #{e.message}"
  EvolutionExceptionTracker.new(e, account: @account).capture_exception
end
```

### Temporal Implementation:
```typescript
export const executeWithErrorHandling = async <T>(
  operation: () => Promise<T>,
  context: { nodeId: string; nodeType: string; accountId: string }
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    log.error(`Node execution failed`, {
      nodeId: context.nodeId,
      nodeType: context.nodeType,
      accountId: context.accountId,
      error: error.message,
      stack: error.stack
    });
    
    // Report to monitoring/tracking service
    // await ExceptionTracker.capture(error, context);
    
    throw error;
  }
};
```

## Validações Importantes

### 1. Agent Assignment Validation
```ruby
# No CRM
def agent_belongs_to_inbox?(agent_ids)
  return false if agent_ids[0] == 'nil'
  @inbox.members.pluck(:user_id).include?(agent_ids[0].to_i)
end
```

### 2. Team Assignment Validation  
```ruby
# No CRM
def team_belongs_to_account?(team_ids)
  return false if team_ids[0] == 'nil'
  @account.teams.pluck(:id).include?(team_ids[0].to_i)
end
```

### Implementação Temporal:
```typescript
async validateAgentAssignment(agentId: string, accountId: string, inboxId: string): Promise<boolean> {
  const response = await fetch(`${this.baseURL}/api/v1/accounts/${accountId}/inboxes/${inboxId}/members`);
  const members = await response.json();
  return members.some((member: any) => member.user_id === agentId);
}
```

## Pontos de Integração Chave

1. **Context Requirements**: Todas ações precisam `conversationId`, `accountId`
2. **Authentication**: Bearer token + X-Account-ID header
3. **Variable Interpolation**: Support para `{{contact.name}}`, `{{conversation.id}}`, etc.
4. **Status Transitions**: Seguir fluxo `open` ↔ `resolved` ↔ `pending` ↔ `snoozed`
5. **Activity Tracking**: Ações triggeram activity messages
6. **Event Publishing**: Ações publicam eventos para outras automações

## Limitações & Considerações

### Send Email to Team
- **Problema**: Não tem endpoint direto na API
- **Solução**: Implementar endpoint customizado ou usar webhook
- **CRM Code**: `TeamNotifications::AutomationNotificationMailer.conversation_creation()`

### Authentication & Rate Limiting
- Implementar retry logic para rate limits
- Cache de tokens/credentials
- Circuit breaker pattern para falhas

### Variable Interpolation
- O CRM usa `parse_email_variables(@conversation, email)`
- Precisamos replicar a mesma lógica de interpolação
- Support para `{{contact.name}}`, `{{agent.name}}`, etc.

## Próximos Passos Sugeridos

1. **Implementar Base Service**: HTTP client com auth e error handling
2. **Criar Endpoint Customizado**: Para send_email_to_team no CRM
3. **Implementar Validations**: Agent/team belongs to account/inbox
4. **Variable Interpolation**: Sistema compatível com CRM
5. **Testing**: Unit tests com mock das APIs
6. **Monitoring**: Logs estruturados e métricas
7. **Documentation**: API usage patterns e examples