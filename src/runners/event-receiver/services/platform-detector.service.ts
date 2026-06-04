import { Injectable } from '@nestjs/common';
import { Platform, isPlatform } from '../../../shared/broker/contracts';

/**
 * Resolves the provider platform from the webhook URL path (story 3.2 / EVO-1209).
 *
 * MVP is path-based only: `/webhooks/<platform>` → the first path segment is
 * matched against the known-provider whitelist. Anything unrecognized resolves
 * to `unknown` (published, not rejected — the event-process consumer drops it
 * downstream, avoiding provider redeliveries).
 */
@Injectable()
export class PlatformDetectorService {
  detect(pathSegment: string | undefined): Platform {
    const candidate = (pathSegment ?? '').split('/')[0].trim().toLowerCase();
    return isPlatform(candidate) ? candidate : 'unknown';
  }
}
