import { Injectable } from '@nestjs/common';
import { StorageProcessor } from '../interfaces/storage-processor.interface';
import { ClickHouseStorageProcessor } from '../storage-processors/clickhouse.processor';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { SegmentJobService } from '../../segments/services/segment-job.service';
import { SegmentInvalidationService } from '../../segments/services/segment-invalidation.service';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

@Injectable()
export class StorageProcessorFactory {
  private static readonly logger = new CustomLoggerService(
    StorageProcessorFactory.name,
  );

  static create(
    clickhouseService?: ClickHouseService,
    segmentJobService?: SegmentJobService,
    segmentInvalidationService?: SegmentInvalidationService,
  ): StorageProcessor {
    if (!clickhouseService) {
      throw new Error('ClickHouse service not provided');
    }

    return new ClickHouseStorageProcessor(
      clickhouseService,
      segmentJobService,
      segmentInvalidationService,
    );
  }
}
