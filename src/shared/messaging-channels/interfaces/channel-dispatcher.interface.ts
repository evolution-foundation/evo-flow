/**
 * Channel-agnostic dispatch seam (story 2.2 / EVO-1202). Today every campaign
 * channel (WhatsApp / email / SMS) is delivered through the CRM inbox, so there
 * is a single concrete dispatcher; the interface lets the future campaign-sender
 * (Epic 4) inject dispatchers by contract without branching on channel.
 */
export interface ChannelDispatchInput {
  contactId: string;
  inboxId: string;
  content: string;
  campaignId: string;
  templateParams?: {
    name: string;
    category?: string;
    language?: string;
    processed_params?: Record<string, unknown>;
  };
}

export interface DispatchResult {
  success: boolean;
  messageId?: string;
  conversationId?: string;
  error?: { code: string; message: string };
  /** Round-trip time of the dispatch call, for future metrics (Epic 5). */
  latencyMs: number;
  statusCode?: number;
}

export interface IChannelDispatcher {
  dispatch(input: ChannelDispatchInput): Promise<DispatchResult>;
}
