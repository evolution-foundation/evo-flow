export interface CachedShortLink {
  id: string;
  shortCode: string;
  originalUrl: string;
  campaignId?: string;
  journeyId?: string;
  contactId?: string;
  isActive: boolean;
  expiresAt?: Date;
  clickCount: number;
  parameters?: Array<{
    key: string;
    value: string;
    isUtm: boolean;
  }>;
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
}
