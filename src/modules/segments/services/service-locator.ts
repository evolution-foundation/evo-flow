import { EventEmitter2 } from '@nestjs/event-emitter';
import { SegmentCacheService } from '../../cache/services/segment-cache.service';

/**
 * Service Locator for TypeORM Entity Listeners
 *
 * Since TypeORM entity listeners can't use dependency injection,
 * we use this pattern to access services in the listeners.
 */

let segmentCacheService: SegmentCacheService | null = null;
let eventEmitter: EventEmitter2 | null = null;

export function setSegmentCacheService(service: SegmentCacheService): void {
  segmentCacheService = service;
}

export function setEventEmitter(emitter: EventEmitter2): void {
  eventEmitter = emitter;
}

export function getSegmentCacheService(): SegmentCacheService | null {
  return segmentCacheService;
}

export function getEventEmitter(): EventEmitter2 | null {
  return eventEmitter;
}

/**
 * Initialize service locator (should be called from module initialization)
 */
export function initializeServiceLocator(
  cacheService: SegmentCacheService,
  emitter: EventEmitter2,
): void {
  setSegmentCacheService(cacheService);
  setEventEmitter(emitter);
}
