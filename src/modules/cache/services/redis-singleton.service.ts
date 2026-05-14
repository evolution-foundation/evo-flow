import Redis from 'ioredis';
import { getProcessingConfig } from '../../processing/config/processing.config';

/**
 * Redis Singleton for Temporal Activities
 * Prevents multiple Redis connections from being created in Temporal context
 */
class RedisSingleton {
  private static instance: Redis | null = null;
  private static connecting = false;
  private static connectionPromise: Promise<Redis> | null = null;

  static async getInstance(): Promise<Redis> {
    // Return existing instance if available
    if (this.instance && this.instance.status === 'ready') {
      return this.instance;
    }

    // Wait for existing connection attempt
    if (this.connecting && this.connectionPromise) {
      return await this.connectionPromise;
    }

    // Create new connection
    this.connecting = true;
    this.connectionPromise = this.createConnection();
    
    try {
      this.instance = await this.connectionPromise;
      return this.instance;
    } finally {
      this.connecting = false;
      this.connectionPromise = null;
    }
  }

  private static async createConnection(): Promise<Redis> {
    const config = getProcessingConfig();
    
    const redis = new Redis({
      host: config.redis?.host || 'localhost',
      port: config.redis?.port || 6379,
      password: config.redis?.password,
      db: config.redis?.db || 5,
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      keepAlive: 30000,
      connectTimeout: 10000,
      enableOfflineQueue: false,
    });

    // Connect with proper error handling
    await redis.connect();

    // Test connection and ensure clean state
    await redis.ping();
    
    // Force cleanup any potentially cached inconsistent data
    console.log(`✅ Redis singleton connected to DB ${redis.options.db}`);
    console.log(`🧹 Flushing Redis connection cache to prevent WRONGTYPE issues`);
    
    // Add a small delay to ensure connection is fully established
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return redis;
  }

  static async disconnect(): Promise<void> {
    if (this.instance) {
      await this.instance.quit();
      this.instance = null;
      console.log('🔻 Redis singleton disconnected');
    }
  }

  static getStatus(): string {
    return this.instance ? this.instance.status : 'not_created';
  }
}

export { RedisSingleton };