import { ClickHouseService } from './clickhouse.service';

/**
 * ClickHouse Singleton for Temporal Activities
 * Prevents multiple ClickHouse connections from being created in Temporal context
 */
class ClickHouseSingleton {
  private static instance: ClickHouseService | null = null;
  private static connecting = false;
  private static connectionPromise: Promise<ClickHouseService> | null = null;

  static async getInstance(): Promise<ClickHouseService> {
    // Return existing instance if available
    if (this.instance) {
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

  private static async createConnection(): Promise<ClickHouseService> {
    const clickHouseService = new ClickHouseService();
    
    // Initialize ClickHouse client ONCE
    await clickHouseService.onModuleInit();
    
    console.log(`✅ ClickHouse singleton initialized for Temporal context`);
    
    return clickHouseService;
  }

  static async disconnect(): Promise<void> {
    if (this.instance) {
      // ClickHouseService doesn't have explicit disconnect, but we can null the instance
      this.instance = null;
      console.log('🔻 ClickHouse singleton disconnected');
    }
  }

  static getStatus(): string {
    return this.instance ? 'ready' : 'not_created';
  }
}

export { ClickHouseSingleton };