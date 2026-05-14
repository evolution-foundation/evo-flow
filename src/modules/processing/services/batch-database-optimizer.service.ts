import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

interface BatchConnection {
  id: string;
  inUse: boolean;
  lastUsed: number;
  operationsCount: number;
}

interface BatchQuery {
  query: string;
  parameters?: Record<string, any>;
  priority: 'HIGH' | 'NORMAL' | 'LOW';
  estimatedRows: number;
  timeout?: number;
}

interface QueryCacheEntry {
  result: any;
  timestamp: number;
  accessCount: number;
  queryHash: string;
}

@Injectable()
export class BatchDatabaseOptimizerService {
  private readonly logger = new CustomLoggerService(
    BatchDatabaseOptimizerService.name,
  );

  // Connection pool management
  private readonly connectionPool = new Map<string, BatchConnection>();
  private readonly maxConnections = 10; // Dedicated batch connections
  private readonly connectionTimeout = 300000; // 5 minutes

  // Query optimization
  private readonly queryCache = new Map<string, QueryCacheEntry>();
  private readonly maxCacheSize = 1000;
  private readonly cacheTimeoutMs = 60000; // 1 minute cache

  // Batch optimization settings
  private readonly optimalBatchSizes = {
    SELECT: 10000, // 10K rows per batch
    INSERT: 5000, // 5K rows per batch
    UPDATE: 1000, // 1K rows per batch
    DELETE: 500, // 500 rows per batch
  };

  constructor(private clickhouseService: ClickHouseService) {
    this.logger.log('🚀 Batch Database Optimizer initialized');

    // Periodic cleanup
    setInterval(() => this.cleanupConnections(), 60000); // Every minute
    setInterval(() => this.cleanupCache(), 300000); // Every 5 minutes
  }

  /**
   * 🚀 OPTIMIZED BATCH QUERY EXECUTION
   * Routes batch queries through optimized connection pool
   */
  async executeBatchQuery(query: BatchQuery): Promise<any> {
    const startTime = Date.now();
    const connectionId = await this.acquireConnection();

    try {
      // Check cache first
      const cacheKey = this.generateCacheKey(query);
      const cachedResult = this.getCachedResult(cacheKey);
      if (cachedResult) {
        this.logger.debug(
          `📊 Cache hit for query: ${query.query.substring(0, 50)}...`,
        );
        return cachedResult;
      }

      // Optimize query based on type and size
      const optimizedQuery = this.optimizeQuery(query);

      // Execute with timeout
      const result = await this.executeWithTimeout(optimizedQuery);

      // Cache result if appropriate
      this.cacheResult(cacheKey, result, query);

      const duration = Date.now() - startTime;
      this.recordQueryMetrics(query, duration, result?.length || 0);

      return result;
    } finally {
      this.releaseConnection(connectionId);
    }
  }

  /**
   * 🔧 BATCH INSERT OPTIMIZATION
   * Optimizes large batch inserts with chunking and parallel processing
   */
  async executeBatchInsert(
    table: string,
    data: any[],
    options?: { chunkSize?: number; parallel?: boolean },
  ): Promise<void> {
    const { chunkSize = this.optimalBatchSizes.INSERT, parallel = true } =
      options || {};

    if (data.length === 0) return;

    this.logger.log(
      `📊 Batch inserting ${data.length} rows into ${table} (chunk size: ${chunkSize})`,
    );

    // Split into optimal chunks
    const chunks = this.chunkArray(data, chunkSize);

    if (parallel && chunks.length > 1) {
      // Parallel execution for large datasets
      await this.executeBatchInsertsParallel(table, chunks);
    } else {
      // Sequential execution for smaller datasets
      await this.executeBatchInsertsSequential(table, chunks);
    }

    this.logger.log(
      `✅ Batch insert completed: ${data.length} rows into ${table}`,
    );
  }

  /**
   * 🎯 QUERY OPTIMIZATION
   * Applies database-specific optimizations based on query pattern
   */
  private optimizeQuery(query: BatchQuery): BatchQuery {
    let optimizedQuery = { ...query };

    // ClickHouse-specific optimizations
    if (query.query.includes('SELECT')) {
      optimizedQuery = this.optimizeSelectQuery(optimizedQuery);
    } else if (query.query.includes('INSERT')) {
      optimizedQuery = this.optimizeInsertQuery(optimizedQuery);
    }

    // Add query hints for large datasets
    if (query.estimatedRows > 100000) {
      optimizedQuery = this.addLargeDatasetHints(optimizedQuery);
    }

    return optimizedQuery;
  }

  /**
   * Optimize SELECT queries for ClickHouse
   */
  private optimizeSelectQuery(query: BatchQuery): BatchQuery {
    let optimizedSQL = query.query;

    // Add FINAL for MergeTree engines if needed
    if (query.estimatedRows < 100000 && !optimizedSQL.includes('FINAL')) {
      optimizedSQL = optimizedSQL.replace(/FROM\s+(\w+)/i, 'FROM $1 FINAL');
    }

    // Add ORDER BY optimization for large datasets
    if (query.estimatedRows > 100000 && !optimizedSQL.includes('ORDER BY')) {
      // Try to add efficient ordering
      if (optimizedSQL.includes('contact_id')) {
        optimizedSQL += ' ORDER BY contact_id';
      }
    }

    // Add LIMIT if missing for safety
    if (query.estimatedRows > 50000 && !optimizedSQL.includes('LIMIT')) {
      optimizedSQL += ` LIMIT ${Math.min(query.estimatedRows, 100000)}`;
    }

    return { ...query, query: optimizedSQL };
  }

  /**
   * Optimize INSERT queries for ClickHouse
   */
  private optimizeInsertQuery(query: BatchQuery): BatchQuery {
    let optimizedSQL = query.query;

    // Add async insert hint for large batches
    if (query.estimatedRows > 1000) {
      // This would be handled at the connection level in real implementation
      this.logger.debug(
        `💡 Large batch insert detected: ${query.estimatedRows} rows`,
      );
    }

    return { ...query, query: optimizedSQL };
  }

  /**
   * Add performance hints for large datasets
   */
  private addLargeDatasetHints(query: BatchQuery): BatchQuery {
    // Add longer timeout for large queries
    const optimizedQuery = {
      ...query,
      timeout: query.timeout || 300000, // 5 minutes
    };

    // Add memory usage settings if needed
    let sql = optimizedQuery.query;

    // ClickHouse settings for large queries
    if (!sql.includes('SETTINGS')) {
      sql += ` SETTINGS max_memory_usage = 10000000000, max_bytes_ratio_before_external_group_by = 0.5`;
    }

    return { ...optimizedQuery, query: sql };
  }

  /**
   * Execute parallel batch inserts
   */
  private async executeBatchInsertsParallel(
    table: string,
    chunks: any[][],
  ): Promise<void> {
    const maxParallel = Math.min(5, chunks.length); // Max 5 parallel inserts

    this.logger.debug(
      `🔄 Executing ${chunks.length} chunks in ${maxParallel} parallel batches`,
    );

    // Process chunks in parallel batches
    for (let i = 0; i < chunks.length; i += maxParallel) {
      const batch = chunks.slice(i, i + maxParallel);

      const insertPromises = batch.map(async (chunk, index) => {
        try {
          await this.clickhouseService.insert({
            table,
            values: chunk,
            asyncInsert: true, // Use async inserts for better performance
          });

          this.logger.debug(
            `✅ Chunk ${i + index + 1} completed (${chunk.length} rows)`,
          );
        } catch (error) {
          this.logger.error(
            `❌ Chunk ${i + index + 1} failed: ${error.message}`,
          );
          throw error;
        }
      });

      await Promise.all(insertPromises);
    }
  }

  /**
   * Execute sequential batch inserts
   */
  private async executeBatchInsertsSequential(
    table: string,
    chunks: any[][],
  ): Promise<void> {
    this.logger.debug(`🔄 Executing ${chunks.length} chunks sequentially`);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      try {
        await this.clickhouseService.insert({
          table,
          values: chunk,
          asyncInsert: false, // Sync inserts for sequential processing
        });

        this.logger.debug(
          `✅ Chunk ${i + 1}/${chunks.length} completed (${chunk.length} rows)`,
        );
      } catch (error) {
        this.logger.error(`❌ Chunk ${i + 1} failed: ${error.message}`);
        throw error;
      }
    }
  }

  /**
   * Connection pool management
   */
  private async acquireConnection(): Promise<string> {
    // Find available connection
    for (const [id, connection] of this.connectionPool.entries()) {
      if (!connection.inUse) {
        connection.inUse = true;
        connection.lastUsed = Date.now();
        connection.operationsCount++;
        return id;
      }
    }

    // Create new connection if under limit
    if (this.connectionPool.size < this.maxConnections) {
      const connectionId = `batch_conn_${Date.now()}_${Math.random()}`;
      this.connectionPool.set(connectionId, {
        id: connectionId,
        inUse: true,
        lastUsed: Date.now(),
        operationsCount: 1,
      });

      this.logger.debug(`🔗 Created new batch connection: ${connectionId}`);
      return connectionId;
    }

    // Wait for available connection
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        for (const [id, connection] of this.connectionPool.entries()) {
          if (!connection.inUse) {
            clearInterval(checkInterval);
            connection.inUse = true;
            connection.lastUsed = Date.now();
            connection.operationsCount++;
            resolve(id);
            return;
          }
        }
      }, 100);

      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Timeout waiting for batch database connection'));
      }, 30000);
    });
  }

  /**
   * Release connection back to pool
   */
  private releaseConnection(connectionId: string): void {
    const connection = this.connectionPool.get(connectionId);
    if (connection) {
      connection.inUse = false;
      connection.lastUsed = Date.now();
    }
  }

  /**
   * Cleanup old connections
   */
  private cleanupConnections(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [id, connection] of this.connectionPool.entries()) {
      if (
        !connection.inUse &&
        now - connection.lastUsed > this.connectionTimeout
      ) {
        this.connectionPool.delete(id);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`🧹 Cleaned up ${cleanedCount} old batch connections`);
    }
  }

  /**
   * Query caching
   */
  private generateCacheKey(query: BatchQuery): string {
    const keyData = `${query.query}:${JSON.stringify(query.parameters)}`;
    return Buffer.from(keyData).toString('base64').substring(0, 32);
  }

  private getCachedResult(cacheKey: string): any | null {
    const cached = this.queryCache.get(cacheKey);
    if (!cached) return null;

    const age = Date.now() - cached.timestamp;
    if (age > this.cacheTimeoutMs) {
      this.queryCache.delete(cacheKey);
      return null;
    }

    cached.accessCount++;
    return cached.result;
  }

  private cacheResult(cacheKey: string, result: any, query: BatchQuery): void {
    // Only cache SELECT results
    if (!query.query.toUpperCase().includes('SELECT')) return;

    // Don't cache large results
    if (JSON.stringify(result).length > 1024 * 1024) return; // 1MB limit

    // Manage cache size
    if (this.queryCache.size >= this.maxCacheSize) {
      const oldestKey = Array.from(this.queryCache.keys())[0];
      this.queryCache.delete(oldestKey);
    }

    this.queryCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      accessCount: 1,
      queryHash: cacheKey,
    });
  }

  /**
   * Cache cleanup
   */
  private cleanupCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, entry] of this.queryCache.entries()) {
      if (now - entry.timestamp > this.cacheTimeoutMs) {
        this.queryCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug(`🧹 Cleaned up ${cleanedCount} expired cache entries`);
    }
  }

  /**
   * Utility methods
   */
  private chunkArray<T>(array: T[], chunkSize: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  private async executeWithTimeout(query: BatchQuery): Promise<any> {
    const timeout = query.timeout || 120000; // 2 minutes default

    return Promise.race([
      this.clickhouseService.query({
        query: query.query,
        parameters: query.parameters,
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Query timeout')), timeout),
      ),
    ]);
  }

  private recordQueryMetrics(
    query: BatchQuery,
    duration: number,
    resultSize: number,
  ): void {
    if (duration > 10000) {
      // Log slow queries (> 10s)
      this.logger.warn(
        `🐌 Slow batch query detected: ${duration}ms, ${resultSize} rows, priority: ${query.priority}`,
      );
    } else {
      this.logger.debug(
        `📊 Batch query completed: ${duration}ms, ${resultSize} rows`,
      );
    }
  }

  /**
   * Get optimization statistics
   */
  getOptimizationStats() {
    const connectionStats = {
      totalConnections: this.connectionPool.size,
      activeConnections: Array.from(this.connectionPool.values()).filter(
        (c) => c.inUse,
      ).length,
      totalOperations: Array.from(this.connectionPool.values()).reduce(
        (sum, c) => sum + c.operationsCount,
        0,
      ),
    };

    const cacheStats = {
      totalCachedQueries: this.queryCache.size,
      totalCacheHits: Array.from(this.queryCache.values()).reduce(
        (sum, c) => sum + c.accessCount - 1,
        0,
      ),
      cacheHitRate: this.calculateCacheHitRate(),
      cacheSizeMB: this.estimateCacheSize(),
    };

    return {
      connectionPool: connectionStats,
      queryCache: cacheStats,
      configuration: {
        maxConnections: this.maxConnections,
        connectionTimeout: this.connectionTimeout,
        maxCacheSize: this.maxCacheSize,
        cacheTimeout: this.cacheTimeoutMs,
        optimalBatchSizes: this.optimalBatchSizes,
      },
    };
  }

  private calculateCacheHitRate(): number {
    const entries = Array.from(this.queryCache.values());
    if (entries.length === 0) return 0;

    const totalRequests = entries.reduce((sum, e) => sum + e.accessCount, 0);
    const cacheHits = entries.reduce((sum, e) => sum + (e.accessCount - 1), 0);

    return totalRequests > 0
      ? Math.round((cacheHits / totalRequests) * 100)
      : 0;
  }

  private estimateCacheSize(): number {
    let totalSize = 0;
    for (const entry of this.queryCache.values()) {
      totalSize += JSON.stringify(entry.result).length;
    }
    return Math.round((totalSize / (1024 * 1024)) * 100) / 100; // MB
  }
}
