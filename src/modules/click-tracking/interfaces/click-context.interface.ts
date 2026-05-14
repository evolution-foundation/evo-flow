export interface ClickContext {
  // Contact identification
  contactId?: string;
  anonymousId?: string;

  // Request data
  ipAddress?: string;
  userAgent?: string;
  referer?: string;
  referrer?: string;

  // Parsed User-Agent
  browser?: string;
  browserVersion?: string;
  operatingSystem?: string;
  os?: string;
  deviceType?: string;

  // Geolocation
  country?: string;
  region?: string;
  city?: string;
  latitude?: number;
  longitude?: number;
  timezone?: string;

  // UTM parameters
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;

  // Custom parameters (any query params that are not UTM)
  customParameters?: Record<string, any>;
}
