# Communication Nodes

This directory contains Temporal activity nodes for handling message sending, email notifications, and transcript delivery in EvoAI.

## Node Types

### SendMessageNode
- **File**: `send-message.node.ts`
- **Purpose**: Sends messages to contacts with optional attachments
- **Action**: Delivers messages through EvoAI conversation channels
- **Configuration**:
  - `message_content`: string (supports variable interpolation)
  - `message_type`: 'text' | 'rich' | 'template'
  - `attachments`: Array of attachment objects (optional)
  - `channel`: 'whatsapp' | 'email' | 'sms' | 'web' (optional)
- **Integration**: EvoAI messaging service API
- **Features**: Template variables, media attachments, delivery tracking

### SendEmailTeamNode
- **File**: `send-email-team.node.ts`
- **Purpose**: Sends email notifications to team members
- **Action**: Notifies teams about conversation events or alerts
- **Configuration**:
  - `team_ids`: string[] (required)
  - `email_subject`: string (supports variables)
  - `email_content`: string (supports variables)
  - `priority`: 'low' | 'normal' | 'high' | 'urgent'
  - `include_conversation_link`: boolean
- **Integration**: EvoAI email service + team management API
- **Features**: Team roster lookup, email templating, conversation context

### SendTranscriptNode
- **File**: `send-transcript.node.ts`
- **Purpose**: Sends conversation transcript via email
- **Action**: Exports and emails conversation history
- **Configuration**:
  - `recipient_email`: string (required)
  - `email_subject`: string (supports variables)
  - `transcript_format`: 'html' | 'pdf' | 'plain_text'
  - `include_metadata`: boolean
  - `date_range`: object (optional, for partial transcripts)
- **Integration**: EvoAI conversation API + email service
- **Features**: Conversation export, formatting options, metadata inclusion

## Common Communication Patterns

All communication nodes will:
1. Validate recipient configuration and permissions
2. Process variable interpolation in content
3. Handle attachments and formatting
4. Execute delivery via appropriate service
5. Track delivery status and errors
6. Generate delivery confirmation variables

## Content Processing

### Variable Interpolation
All text content supports dynamic variables:
- `{{contact.name}}`: Contact name
- `{{conversation.id}}`: Conversation identifier  
- `{{agent.name}}`: Assigned agent name
- `{{timestamp}}`: Current timestamp
- Custom journey variables

### Template Support
- **Message Templates**: Predefined message formats
- **Email Templates**: HTML email layouts
- **Transcript Templates**: Conversation export formats

## Delivery Tracking

### Message Delivery
- **Status Tracking**: sent, delivered, read, failed
- **Retry Logic**: Exponential backoff for failures
- **Webhook Integration**: Delivery status callbacks

### Email Delivery
- **SMTP Integration**: Email service provider APIs
- **Bounce Handling**: Failed delivery management
- **Unsubscribe**: Team notification preferences

## Error Handling

- **Invalid Recipients**: Validation with clear error messages
- **Content Errors**: Template processing failures
- **Delivery Failures**: Retry logic with status tracking
- **Attachment Issues**: Size limits, format validation
- **Permission Denied**: Account/team access verification

## Variables Generated

### Send Message Variables:
- `message_sent`: boolean
- `message_id`: string
- `delivery_status`: string
- `send_timestamp`: ISO date string
- `recipient_count`: number

### Send Email Team Variables:
- `email_sent`: boolean
- `email_id`: string
- `recipient_teams`: string[]
- `recipient_count`: number
- `send_timestamp`: ISO date string

### Send Transcript Variables:
- `transcript_sent`: boolean
- `transcript_id`: string
- `recipient_email`: string
- `transcript_format`: string
- `send_timestamp`: ISO date string

## Integration Requirements

- **EvoAI Messaging API**: Multi-channel message delivery
- **Email Service**: SMTP/API integration for email delivery
- **File Storage**: Attachment and transcript file management
- **Team Management**: Team member lookup and preferences
- **Conversation API**: Transcript export and formatting