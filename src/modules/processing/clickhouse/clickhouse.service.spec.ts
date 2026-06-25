jest.mock('@clickhouse/client', () => ({
  createClient: jest.fn(),
}));

jest.mock('../config/processing.config', () => ({
  getProcessingConfig: jest.fn(() => ({
    clickhouse: {
      protocol: 'http',
      host: 'localhost',
      port: 8123,
      database: 'evo_campaign',
      username: 'default',
      password: '',
    },
    kafka: {
      brokersInternal: 'evo-campaign-kafka:29092',
      topic: 'evo-campaign-events',
      groupId: 'evo-campaign-consumers',
    },
  })),
}));

import { ClickHouseService } from './clickhouse.service';

type ServiceInternals = {
  ensureKafkaEngineBroker(
    databaseName: string,
    tableName: string,
    expectedBrokers: string,
    dependentViews?: string[],
  ): Promise<boolean>;
  extractKafkaBrokers(createTableQuery: string): string | null;
  query: jest.Mock;
  command: jest.Mock;
  logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
};

describe('ClickHouseService — journey-trigger broker guard (EVO-1893)', () => {
  let service: ClickHouseService;
  let internals: ServiceInternals;

  beforeEach(() => {
    service = new ClickHouseService();
    internals = service as unknown as ServiceInternals;
    internals.query = jest.fn();
    internals.command = jest.fn().mockResolvedValue(undefined);
    internals.logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
  });

  describe('extractKafkaBrokers', () => {
    it('extracts the broker from a Kafka Engine DDL', () => {
      const ddl =
        "CREATE TABLE evo_campaign.journey_trigger_kafka_queue (x String) " +
        "ENGINE = Kafka('localhost:9092', 'journey-triggers', 'temporal-workers', 'JSONEachRow')";
      expect(internals.extractKafkaBrokers(ddl)).toBe('localhost:9092');
    });

    it('returns null when there is no Kafka() engine', () => {
      expect(
        internals.extractKafkaBrokers('ENGINE = MergeTree() ORDER BY x'),
      ).toBeNull();
    });
  });

  describe('ensureKafkaEngineBroker', () => {
    it('does nothing when the table does not exist', async () => {
      internals.query.mockResolvedValue([]);

      const dropped = await internals.ensureKafkaEngineBroker(
        'evo_campaign',
        'journey_trigger_kafka_queue',
        'evo-campaign-kafka:29092',
        ['events_to_journey_triggers_mv'],
      );

      expect(dropped).toBe(false);
      expect(internals.command).not.toHaveBeenCalled();
    });

    it('does nothing when the broker already matches', async () => {
      internals.query.mockResolvedValue([
        {
          engine: 'Kafka',
          create:
            "ENGINE = Kafka('evo-campaign-kafka:29092', 'journey-triggers', 'temporal-workers', 'JSONEachRow')",
        },
      ]);

      const dropped = await internals.ensureKafkaEngineBroker(
        'evo_campaign',
        'journey_trigger_kafka_queue',
        'evo-campaign-kafka:29092',
        ['events_to_journey_triggers_mv'],
      );

      expect(dropped).toBe(false);
      expect(internals.command).not.toHaveBeenCalled();
    });

    it('drops the dependent view and table when the broker is stale', async () => {
      internals.query.mockResolvedValue([
        {
          engine: 'Kafka',
          create:
            "ENGINE = Kafka('localhost:9092', 'journey-triggers', 'temporal-workers', 'JSONEachRow')",
        },
      ]);

      const dropped = await internals.ensureKafkaEngineBroker(
        'evo_campaign',
        'journey_trigger_kafka_queue',
        'evo-campaign-kafka:29092',
        ['events_to_journey_triggers_mv'],
      );

      expect(dropped).toBe(true);
      const commands = internals.command.mock.calls.map((c) => c[0].query);
      // MV must be dropped before the source Kafka table.
      expect(commands[0]).toContain(
        'DROP VIEW IF EXISTS evo_campaign.events_to_journey_triggers_mv',
      );
      expect(commands[1]).toContain(
        'DROP TABLE IF EXISTS evo_campaign.journey_trigger_kafka_queue',
      );
      expect(internals.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('stale broker'),
      );
    });

    it('leaves non-Kafka tables untouched', async () => {
      internals.query.mockResolvedValue([
        { engine: 'MergeTree', create: 'ENGINE = MergeTree() ORDER BY x' },
      ]);

      const dropped = await internals.ensureKafkaEngineBroker(
        'evo_campaign',
        'some_table',
        'evo-campaign-kafka:29092',
      );

      expect(dropped).toBe(false);
      expect(internals.command).not.toHaveBeenCalled();
    });

    it('does not block boot when validation throws', async () => {
      internals.query.mockRejectedValue(new Error('clickhouse down'));

      const dropped = await internals.ensureKafkaEngineBroker(
        'evo_campaign',
        'journey_trigger_kafka_queue',
        'evo-campaign-kafka:29092',
        ['events_to_journey_triggers_mv'],
      );

      expect(dropped).toBe(false);
      expect(internals.command).not.toHaveBeenCalled();
      expect(internals.logger.error).toHaveBeenCalled();
    });
  });
});
