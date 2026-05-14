// Padronização de nomes de eventos para consistência

export const EMAIL_EVENTS = {
  SENT: 'email_sent',
  DELIVERED: 'email_delivered',
  OPENED: 'email_opened',
  CLICKED: 'email_clicked',
  BOUNCED: 'email_bounced',
  UNSUBSCRIBED: 'email_unsubscribed',
  MARKED_AS_SPAM: 'email_marked_as_spam',
} as const;

export const SMS_EVENTS = {
  SENT: 'sms_sent',
  DELIVERED: 'sms_delivered',
  FAILED: 'sms_failed',
  REPLIED: 'sms_replied',
} as const;

export const WHATSAPP_EVENTS = {
  SENT: 'whatsapp_sent',
  DELIVERED: 'whatsapp_delivered',
  READ: 'whatsapp_read',
  REPLIED: 'whatsapp_replied',
  FAILED: 'whatsapp_failed',
} as const;

export const WEB_EVENTS = {
  PAGE_VIEW: 'page_viewed',
  FORM_SUBMITTED: 'form_submitted',
  BUTTON_CLICKED: 'button_clicked',
  FILE_DOWNLOADED: 'file_downloaded',
  CHAT_OPENED: 'chat_opened',
  CHAT_MESSAGE_SENT: 'chat_message_sent',
} as const;

export const CAMPAIGN_EVENTS = {
  JOURNEY_ENTERED: 'journey_entered',
  JOURNEY_EXITED: 'journey_exited',
  STEP_COMPLETED: 'step_completed',
  GOAL_ACHIEVED: 'goal_achieved',
} as const;

// Union type para TypeScript
export type PredefinedEventName =
  | (typeof EMAIL_EVENTS)[keyof typeof EMAIL_EVENTS]
  | (typeof SMS_EVENTS)[keyof typeof SMS_EVENTS]
  | (typeof WHATSAPP_EVENTS)[keyof typeof WHATSAPP_EVENTS]
  | (typeof WEB_EVENTS)[keyof typeof WEB_EVENTS]
  | (typeof CAMPAIGN_EVENTS)[keyof typeof CAMPAIGN_EVENTS];

export type EventName = PredefinedEventName; // Use PredefinedEventName for type safety, or string for custom events
