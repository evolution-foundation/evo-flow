export interface EventData {
  messageId: string;
  contactId?: string;
  anonymousId?: string;
  eventType: 'track' | 'identify' | 'page' | 'screen' | 'segment' | 'journey';
  eventName?: string;
  properties?: Record<string, any>;
  traits?: Record<string, any>;
  timestamp?: string;
  context?: Record<string, any>;
}

export interface ProcessingResult {
  messageId: string;
  status: 'success' | 'queued' | 'error';
  error?: string;
  queueInfo?: {
    queue: string;
    mode: string;
    writeMode?: string;
  };
}
