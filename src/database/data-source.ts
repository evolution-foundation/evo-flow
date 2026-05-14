import { DataSource } from 'typeorm';
import { AppDataSource } from './ormconfig';

let dataSource: DataSource;

export function getDataSource(): DataSource {
  if (!dataSource) {
    dataSource = AppDataSource;
    if (!dataSource.isInitialized) {
      throw new Error(
        'DataSource not initialized. Make sure to call initialize() first.',
      );
    }
  }
  return dataSource;
}

export function setDataSource(ds: DataSource): void {
  dataSource = ds;
}
