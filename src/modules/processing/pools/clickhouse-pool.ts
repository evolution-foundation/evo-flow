import { Injectable, OnModuleDestroy } from '@nestjs/common';
import {
  createClient,
  ClickHouseClient,
  ClickHouseClientConfigOptions,
} from '@clickhouse/client';
import { EventEmitter } from 'events';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface PoolConfig {
  min: number;
  max: number;
  acquireTimeoutMillis: number;
  idleTimeoutMillis: number;
  reapIntervalMillis: number;
  createTimeoutMillis: number;
  destroyTimeoutMillis: number;
}

export interface PoolStats {
  size: number;
  available: number;
  borrowed: number;
  pending: number;
  invalid: number;
}

interface PooledClient {
  client: ClickHouseClient;
  id: string;
  createdAt: Date;
  lastUsed: Date;
  isValid: boolean;
  inUse: boolean;
}

@Injectable()
export class ClickHousePool extends EventEmitter implements OnModuleDestroy {
  private readonly logger = new CustomLoggerService(ClickHousePool.name);

  private clients: Map<string, PooledClient> = new Map();
  private availableClients: Set<string> = new Set();
  private pendingAcquisitions: Array<{
    resolve: (client: ClickHouseClient) => void;
    reject: (error: Error) => void;
    timestamp: Date;
  }> = [];

  private reapTimer?: NodeJS.Timeout;
  private isDestroyed = false;
  private clientCounter = 0;

  private readonly config: PoolConfig;
  private readonly clientConfig: ClickHouseClientConfigOptions;

  constructor(
    clientConfig: ClickHouseClientConfigOptions,
    poolConfig: Partial<PoolConfig> = {},
  ) {
    super();

    this.clientConfig = clientConfig;
    this.config = {
      min: 2,
      max: 10,
      acquireTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      reapIntervalMillis: 1000,
      createTimeoutMillis: 5000,
      destroyTimeoutMillis: 5000,
      ...poolConfig,
    };

    this.logger.log('ClickHouse pool initializing...', {
      min: this.config.min,
      max: this.config.max,
      host: clientConfig.host,
    });

    this.initialize();
  }

  private async initialize(): Promise<void> {
    // Create minimum clients
    for (let i = 0; i < this.config.min; i++) {
      try {
        await this.createClient();
      } catch (error) {
        this.logger.error(
          `Failed to create initial client ${i}: ${error.message}`,
        );
      }
    }

    // Start reaper for idle connections
    this.reapTimer = setInterval(() => {
      this.reapIdleClients();
    }, this.config.reapIntervalMillis);

    this.logger.log(
      `ClickHouse pool initialized with ${this.clients.size} clients`,
    );
    this.emit('ready');
  }

  async acquire(): Promise<ClickHouseClient> {
    if (this.isDestroyed) {
      throw new Error('Pool is destroyed');
    }

    // Try to get available client
    const availableId = this.availableClients.values().next().value;
    if (availableId) {
      const pooledClient = this.clients.get(availableId)!;

      // Validate client health
      if (await this.validateClient(pooledClient)) {
        this.availableClients.delete(availableId);
        pooledClient.inUse = true;
        pooledClient.lastUsed = new Date();

        this.logger.debug(`Acquired client ${availableId} from pool`);
        return pooledClient.client;
      } else {
        // Remove invalid client
        await this.destroyClient(availableId);
      }
    }

    // Create new client if under max limit
    if (this.clients.size < this.config.max) {
      try {
        const pooledClient = await this.createClient();
        pooledClient.inUse = true;
        pooledClient.lastUsed = new Date();

        this.logger.debug(`Created new client ${pooledClient.id}`);
        return pooledClient.client;
      } catch (error) {
        this.logger.error(`Failed to create new client: ${error.message}`);
      }
    }

    // Queue acquisition request
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.pendingAcquisitions.findIndex(
          (p) => p.resolve === resolve,
        );
        if (index >= 0) {
          this.pendingAcquisitions.splice(index, 1);
        }
        reject(
          new Error(
            `Acquire timeout after ${this.config.acquireTimeoutMillis}ms`,
          ),
        );
      }, this.config.acquireTimeoutMillis);

      this.pendingAcquisitions.push({
        resolve: (client) => {
          clearTimeout(timeout);
          resolve(client);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timestamp: new Date(),
      });

      this.logger.debug(
        `Queued acquisition request, pending: ${this.pendingAcquisitions.length}`,
      );
    });
  }

  async release(client: ClickHouseClient): Promise<void> {
    if (this.isDestroyed) {
      return;
    }

    // Find the pooled client
    let pooledClientId: string | undefined;
    for (const [id, pooledClient] of this.clients) {
      if (pooledClient.client === client) {
        pooledClientId = id;
        break;
      }
    }

    if (!pooledClientId) {
      this.logger.warn('Attempted to release unknown client');
      return;
    }

    const pooledClient = this.clients.get(pooledClientId)!;
    pooledClient.inUse = false;
    pooledClient.lastUsed = new Date();

    // Validate client before returning to pool
    if (await this.validateClient(pooledClient)) {
      this.availableClients.add(pooledClientId);
      this.logger.debug(`Released client ${pooledClientId} back to pool`);

      // Process pending acquisitions
      this.processPendingAcquisitions();
    } else {
      // Destroy invalid client
      await this.destroyClient(pooledClientId);

      // Try to maintain minimum pool size
      if (this.clients.size < this.config.min) {
        try {
          await this.createClient();
        } catch (error) {
          this.logger.error(
            `Failed to create replacement client: ${error.message}`,
          );
        }
      }
    }
  }

  private async createClient(): Promise<PooledClient> {
    const id = `ch-client-${++this.clientCounter}`;
    const startTime = Date.now();

    try {
      const client = createClient(this.clientConfig);

      // Test connection
      await Promise.race([
        client.ping(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('Create timeout')),
            this.config.createTimeoutMillis,
          ),
        ),
      ]);

      const pooledClient: PooledClient = {
        client,
        id,
        createdAt: new Date(),
        lastUsed: new Date(),
        isValid: true,
        inUse: false,
      };

      this.clients.set(id, pooledClient);
      this.availableClients.add(id);

      const createTime = Date.now() - startTime;
      this.logger.debug(`Created client ${id} in ${createTime}ms`);

      this.emit('clientCreated', { id, createTime });
      return pooledClient;
    } catch (error) {
      this.logger.error(`Failed to create client ${id}: ${error.message}`);
      throw error;
    }
  }

  private async destroyClient(id: string): Promise<void> {
    const pooledClient = this.clients.get(id);
    if (!pooledClient) {
      return;
    }

    this.clients.delete(id);
    this.availableClients.delete(id);

    try {
      await Promise.race([
        pooledClient.client.close(),
        new Promise((resolve) =>
          setTimeout(resolve, this.config.destroyTimeoutMillis),
        ),
      ]);

      this.logger.debug(`Destroyed client ${id}`);
      this.emit('clientDestroyed', { id });
    } catch (error) {
      this.logger.error(`Error destroying client ${id}: ${error.message}`);
    }
  }

  private async validateClient(pooledClient: PooledClient): Promise<boolean> {
    try {
      // Quick health check
      await Promise.race([
        pooledClient.client.ping(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Validation timeout')), 1000),
        ),
      ]);

      pooledClient.isValid = true;
      return true;
    } catch (error) {
      this.logger.debug(
        `Client ${pooledClient.id} validation failed: ${error.message}`,
      );
      pooledClient.isValid = false;
      return false;
    }
  }

  private async processPendingAcquisitions(): Promise<void> {
    while (
      this.pendingAcquisitions.length > 0 &&
      this.availableClients.size > 0
    ) {
      const pending = this.pendingAcquisitions.shift()!;
      const availableId = this.availableClients.values().next().value!;
      const pooledClient = this.clients.get(availableId)!;

      if (await this.validateClient(pooledClient)) {
        this.availableClients.delete(availableId);
        pooledClient.inUse = true;
        pooledClient.lastUsed = new Date();

        pending.resolve(pooledClient.client);
        this.logger.debug(
          `Resolved pending acquisition with client ${availableId}`,
        );
      } else {
        await this.destroyClient(availableId);
      }
    }
  }

  private reapIdleClients(): void {
    const now = new Date();
    const idleThreshold = now.getTime() - this.config.idleTimeoutMillis;

    for (const [id, pooledClient] of this.clients) {
      if (
        !pooledClient.inUse &&
        pooledClient.lastUsed.getTime() < idleThreshold &&
        this.clients.size > this.config.min
      ) {
        this.destroyClient(id);
        this.logger.debug(`Reaped idle client ${id}`);
      }
    }
  }

  getStats(): PoolStats {
    const available = this.availableClients.size;
    const borrowed = Array.from(this.clients.values()).filter(
      (c) => c.inUse,
    ).length;
    const invalid = Array.from(this.clients.values()).filter(
      (c) => !c.isValid,
    ).length;

    return {
      size: this.clients.size,
      available,
      borrowed,
      pending: this.pendingAcquisitions.length,
      invalid,
    };
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log('Destroying ClickHouse pool...');
    this.isDestroyed = true;

    // Clear reap timer
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
    }

    // Reject pending acquisitions
    for (const pending of this.pendingAcquisitions) {
      pending.reject(new Error('Pool is being destroyed'));
    }
    this.pendingAcquisitions.length = 0;

    // Destroy all clients
    const destroyPromises = Array.from(this.clients.keys()).map((id) =>
      this.destroyClient(id),
    );

    await Promise.all(destroyPromises);
    this.logger.log('ClickHouse pool destroyed');
  }
}
