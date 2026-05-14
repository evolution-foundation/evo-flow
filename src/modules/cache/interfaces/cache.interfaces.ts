// Generic cache interfaces (single-account)
export interface CacheStats {
  l1CacheHits: number;
  l1CacheMisses: number;
  l2CacheHits: number;
  l2CacheMisses: number;
  databaseHits: number;
  totalRequests: number;
  l1CacheSize: number;
  l2CacheSize: number;
  hitRatePercent: number;
}

export interface CacheableEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CachedEntity {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  lastCached: Date;
  // Allow any additional properties
  [key: string]: any;
}

export interface CacheConfig {
  redisKeyPrefix: string;
  memoryMaxSize: number;
  memoryTtlMs: number;
  redisTtlSeconds: number;
  enableL2Cache: boolean;
  enableStats: boolean;
}

export interface EntityCacheService<
  T extends CacheableEntity,
  C extends CachedEntity,
> {
  get(id: string): Promise<C | null>;
  getMultiple(ids: string[]): Promise<C[]>;
  getAll(limit?: number): Promise<C[]>;
  set(entity: T): Promise<void>;
  setMultiple(entities: T[]): Promise<void>;
  invalidate(id: string): Promise<void>;
  invalidateAll(): Promise<void>;
  getStats(): CacheStats;
  healthCheck(): Promise<boolean>;
}
