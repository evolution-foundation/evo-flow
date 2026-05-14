import { DataSource } from 'typeorm';
import 'dotenv/config';

// Postgres-only configuration. SQLite mode removed (evo-flow-cleanup).
if (!process.env.POSTGRES_DB_HOST) {
  throw new Error(
    'POSTGRES_DB_HOST is required; SQLite mode removed.',
  );
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_DB_HOST,
  port: parseInt(process.env.POSTGRES_DB_PORT || '5432'),
  username: process.env.POSTGRES_DB_USERNAME,
  password: process.env.POSTGRES_DB_PASSWORD,
  database: process.env.POSTGRES_DB_DATABASE,
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: ['dist/**/*.entity.js'],
  migrations: ['dist/database/migrations/*.js'],
  ssl:
    process.env.POSTGRES_SSLMODE === 'require'
      ? { rejectUnauthorized: false }
      : false,
  extra: {
    connectionLimit: 10,
  },
});
