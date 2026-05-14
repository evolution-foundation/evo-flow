import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { SegmentMetricsService } from '../../segments/metrics/segment-metrics.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface PreparedQuery {
  id: string;
  query: string;
  parameters: string[];
  lastUsed: Date;
  usageCount: number;
}

export interface OptimizedUpdateResult {
  contactId: string;
  segmentId: string;
  success: boolean;
  queryTime: number;
  rowsAffected: number;
  cacheHit: boolean;
}

export interface ConnectionPoolStats {
  total: number;
  active: number;
  idle: number;
  waiting: number;
}

@Injectable()
export class SingleContactUpdaterService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(
    SingleContactUpdaterService.name,
  );
  private readonly preparedQueries = new Map<string, PreparedQuery>();
  private readonly queryCache = new Map<string, any[]>();
  private readonly MAX_PREPARED_QUERIES = 100;
  private readonly QUERY_CACHE_TTL = 30 * 1000; // 30 seconds
  private readonly CONNECTION_POOL_SIZE = 10;

  // Dedicated connection pool for atomic operations
  private atomicConnectionPool: any[] = [];
  private availableConnections: any[] = [];
  private busyConnections: Set<any> = new Set();

  constructor(
    private readonly clickHouseService: ClickHouseService,
    private readonly metrics: SegmentMetricsService,
  ) {}

  async onModuleInit() {
    await this.initializeConnectionPool();
    this.startQueryCacheCleanup();
  }

  async onModuleDestroy() {
    await this.closeConnectionPool();
  }

  async updateSingleContact(
    contactId: string,
    segmentId: string,
    segmentLogic: string,
    timeWindowDays: number = 30,
  ): Promise<OptimizedUpdateResult> {
    const startTime = Date.now();
    let connection = null;
    let cacheHit = false;

    try {
      // 1. Check query cache first
      const cacheKey = `${contactId}:${segmentId}`;
      const cachedResult = this.queryCache.get(cacheKey);

      if (cachedResult) {
        cacheHit = true;
        this.logger.debug(`Query cache hit for ${cacheKey}`);
        return {
          contactId,
          segmentId,
          success: true,
          queryTime: Date.now() - startTime,
          rowsAffected: (cachedResult as any)?.rowsAffected || 0,
          cacheHit,
        };
      }

      // 2. Get prepared query
      const preparedQuery = await this.getPreparedQuery(
        segmentLogic,
        timeWindowDays,
      );

      // 3. Get dedicated connection
      connection = await this.getConnection();

      // 4. Execute optimized query
      const query = preparedQuery.query
        .replace('{contactId}', `'${contactId}'`)
        .replace('{segmentId}', `'${segmentId}'`)
        .replace('{timeWindow}', timeWindowDays.toString());

      const result = await this.executeWithConnection(connection, query);
      const queryTime = Date.now() - startTime;

      // 5. Cache successful results
      if (result.rowsAffected !== undefined) {
        const cacheData = { ...result, timestamp: Date.now() };
        this.queryCache.set(cacheKey, cacheData);
        setTimeout(
          () => this.queryCache.delete(cacheKey),
          this.QUERY_CACHE_TTL,
        );
      }

      // 6. Update prepared query stats
      preparedQuery.lastUsed = new Date();
      preparedQuery.usageCount++;

      // 7. Record metrics
      this.metrics.recordSingleContactUpdate({
        queryTime,
        cacheHit,
        success: true,
        segmentId,
      });

      return {
        contactId,
        segmentId,
        success: true,
        queryTime,
        rowsAffected: result.rowsAffected || 0,
        cacheHit,
      };
    } catch (error) {
      const queryTime = Date.now() - startTime;

      this.logger.error(
        `Failed to update single contact: ${contactId}, segment: ${segmentId}`,
        error,
      );

      this.metrics.recordSingleContactUpdate({
        queryTime,
        cacheHit,
        success: false,
        segmentId,
        error: error.message,
      });

      return {
        contactId,
        segmentId,
        success: false,
        queryTime,
        rowsAffected: 0,
        cacheHit,
      };
    } finally {
      // Always release connection
      if (connection) {
        this.releaseConnection(connection);
      }
    }
  }

  private async initializeConnectionPool(): Promise<void> {
    this.logger.log(
      `Initializing dedicated connection pool with ${this.CONNECTION_POOL_SIZE} connections`,
    );

    for (let i = 0; i < this.CONNECTION_POOL_SIZE; i++) {
      try {
        const connection = await this.createOptimizedConnection();
        this.atomicConnectionPool.push(connection);
        this.availableConnections.push(connection);

        this.logger.debug(
          `Created connection ${i + 1}/${this.CONNECTION_POOL_SIZE}`,
        );
      } catch (error) {
        this.logger.error(`Failed to create connection ${i + 1}`, error);
      }
    }

    this.logger.log(
      `Connection pool initialized with ${this.availableConnections.length} connections`,
    );
  }

  private async createOptimizedConnection(): Promise<any> {
    // Create optimized ClickHouse connection for atomic operations
    const connectionConfig = {
      // Optimized settings for single contact queries
      query_timeout: 2000, // 2 seconds max
      connect_timeout: 1000, // 1 second connection timeout
      max_execution_time: 2, // 2 seconds query execution limit

      // Memory optimizations
      max_memory_usage: 100 * 1024 * 1024, // 100MB max per query
      max_threads: 2, // Limit threads for single contact queries

      // Performance settings
      max_block_size: 1000,
      prefer_localhost_replica: 1,

      // Connection pooling
      connection_pool_size: 1,
      keep_alive_timeout: 30,
    };

    // For now, return the main service connection
    // TODO: Implement actual connection pooling in ClickHouseService
    return this.clickHouseService;
  }

  private async getConnection(): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection pool timeout: no available connections'));
      }, 5000); // 5 second timeout

      const checkConnection = () => {
        if (this.availableConnections.length > 0) {
          clearTimeout(timeout);
          const connection = this.availableConnections.pop();
          this.busyConnections.add(connection);
          resolve(connection);
        } else {
          // Check again in 10ms
          setTimeout(checkConnection, 10);
        }
      };

      checkConnection();
    });
  }

  private releaseConnection(connection: any): void {
    if (this.busyConnections.has(connection)) {
      this.busyConnections.delete(connection);
      this.availableConnections.push(connection);
    }
  }

  private async closeConnectionPool(): Promise<void> {
    this.logger.log('Closing connection pool');

    for (const connection of this.atomicConnectionPool) {
      try {
        await connection.close();
      } catch (error) {
        this.logger.error('Failed to close connection', error);
      }
    }

    this.atomicConnectionPool.length = 0;
    this.availableConnections.length = 0;
    this.busyConnections.clear();
  }

  private async getPreparedQuery(
    segmentLogic: string,
    timeWindowDays: number,
  ): Promise<PreparedQuery> {
    const queryKey = `${segmentLogic}:${timeWindowDays}`;

    let preparedQuery = this.preparedQueries.get(queryKey);

    if (!preparedQuery) {
      // Create new prepared query
      preparedQuery = {
        id: queryKey,
        query: this.buildOptimizedQuery(segmentLogic, timeWindowDays),
        parameters: ['contactId', 'segmentId', 'timeWindow'],
        lastUsed: new Date(),
        usageCount: 0,
      };

      // Clean up old prepared queries if limit exceeded
      if (this.preparedQueries.size >= this.MAX_PREPARED_QUERIES) {
        this.cleanupPreparedQueries();
      }

      this.preparedQueries.set(queryKey, preparedQuery);
      this.logger.debug(`Created prepared query: ${queryKey}`);
    }

    return preparedQuery;
  }

  private buildOptimizedQuery(
    segmentLogic: string,
    timeWindowDays: number,
  ): string {
    return `
      WITH segment_check AS (
        SELECT
          {segmentId} as computed_property_id,
          {contactId} as contact_id,
          ${segmentLogic} as segment_value,
          now() as assigned_at
        FROM contact_events
        WHERE contact_id = {contactId}
          AND occurred_at > now() - INTERVAL {timeWindow} DAY
          AND occurred_at <= now()
        GROUP BY contact_id
        LIMIT 1
      ),
      upsert_data AS (
        SELECT * FROM segment_check
        WHERE segment_value IS NOT NULL
      )
      INSERT INTO computed_property_assignments_v2
      (computed_property_id, contact_id, segment_value, assigned_at)
      SELECT * FROM upsert_data
      SETTINGS insert_deduplication_token = concat(computed_property_id, ':', contact_id)
    `;
  }

  private async executeWithConnection(
    connection: any,
    query: string,
  ): Promise<any> {
    try {
      const result = await connection.query(query);
      return {
        rowsAffected: result.meta?.statistics?.rows_written || 1,
        executionTime: result.meta?.statistics?.elapsed || 0,
      };
    } catch (error) {
      // Enhanced error handling for common ClickHouse issues
      if (error.message.includes('timeout')) {
        throw new Error(`Query timeout: ${error.message}`);
      } else if (error.message.includes('memory')) {
        throw new Error(`Memory limit exceeded: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  private cleanupPreparedQueries(): void {
    // Remove least recently used prepared queries
    const sortedQueries = Array.from(this.preparedQueries.entries()).sort(
      ([, a], [, b]) => a.lastUsed.getTime() - b.lastUsed.getTime(),
    );

    const toRemove = Math.ceil(this.MAX_PREPARED_QUERIES * 0.2); // Remove 20%

    for (let i = 0; i < toRemove && sortedQueries.length > 0; i++) {
      const [key] = sortedQueries[i];
      this.preparedQueries.delete(key);
    }

    this.logger.debug(`Cleaned up ${toRemove} prepared queries`);
  }

  private startQueryCacheCleanup(): void {
    // Clean up expired cache entries every minute
    setInterval(() => {
      const now = Date.now();
      let cleaned = 0;

      for (const [key, data] of this.queryCache.entries()) {
        if (
          (data as any)?.timestamp &&
          now - (data as any).timestamp > this.QUERY_CACHE_TTL
        ) {
          this.queryCache.delete(key);
          cleaned++;
        }
      }

      if (cleaned > 0) {
        this.logger.debug(`Cleaned up ${cleaned} expired cache entries`);
      }
    }, 60000);
  }

  // Performance monitoring methods
  getConnectionPoolStats(): ConnectionPoolStats {
    return {
      total: this.atomicConnectionPool.length,
      active: this.busyConnections.size,
      idle: this.availableConnections.length,
      waiting: Math.max(
        0,
        this.busyConnections.size - this.atomicConnectionPool.length,
      ),
    };
  }

  getPreparedQueryStats(): {
    count: number;
    hitRate: number;
    queries: PreparedQuery[];
  } {
    const queries = Array.from(this.preparedQueries.values());
    const totalUsage = queries.reduce((sum, q) => sum + q.usageCount, 0);
    const uniqueQueries = queries.length;

    return {
      count: uniqueQueries,
      hitRate: uniqueQueries > 0 ? totalUsage / uniqueQueries : 0,
      queries: queries.sort((a, b) => b.usageCount - a.usageCount),
    };
  }

  getQueryCacheStats(): { size: number; hitRate: number } {
    return {
      size: this.queryCache.size,
      hitRate: 0, // TODO: Implement proper hit rate tracking
    };
  }

  // Administrative methods
  async flushQueryCache(): Promise<void> {
    this.queryCache.clear();
    this.logger.log('Query cache flushed');
  }

  async flushPreparedQueries(): Promise<void> {
    this.preparedQueries.clear();
    this.logger.log('Prepared queries flushed');
  }

  async healthCheck(): Promise<{ status: string; details: any }> {
    try {
      const poolStats = this.getConnectionPoolStats();
      const queryStats = this.getPreparedQueryStats();

      // Test a simple connection
      const testConnection = await this.getConnection();
      const testResult = await this.executeWithConnection(
        testConnection,
        'SELECT 1 as test',
      );
      this.releaseConnection(testConnection);

      return {
        status: 'healthy',
        details: {
          connectionPool: poolStats,
          preparedQueries: {
            count: queryStats.count,
            hitRate: queryStats.hitRate,
          },
          queryCache: this.getQueryCacheStats(),
          testQuery: testResult ? 'success' : 'failed',
        },
      };
    } catch (error) {
      return {
        status: 'unhealthy',
        details: {
          error: error.message,
          connectionPool: this.getConnectionPoolStats(),
        },
      };
    }
  }
}
