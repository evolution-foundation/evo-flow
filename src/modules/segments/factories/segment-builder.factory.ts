import { Injectable } from '@nestjs/common';
import { ClickHouseService } from '../../processing/clickhouse/clickhouse.service';
import { BaseSegmentBuilder } from '../services/segment-builders/base-segment-builder';
import { EveryoneSegmentBuilder } from '../services/segment-builders/everyone-segment-builder';
import { LabelSegmentBuilder } from '../services/segment-builders/label-segment-builder';
import { CustomAttributeSegmentBuilder } from '../services/segment-builders/custom-attribute-segment-builder';
import { UserPropertySegmentBuilder } from '../services/segment-builders/user-property-segment-builder';
import { PerformedSegmentBuilder } from '../services/segment-builders/performed-segment-builder';
import { EmailSegmentBuilder } from '../services/segment-builders/email-segment-builder';
import { ChannelSegmentBuilder } from '../services/segment-builders/channel-segment-builder';
import { RandomBucketSegmentBuilder } from '../services/segment-builders/random-bucket-segment-builder';
import {
  SegmentNode,
  BaseSegmentBuilderConfig,
} from '../types/segment-computation.types';

@Injectable()
export class SegmentBuilderFactory {
  constructor(private readonly clickHouseService: ClickHouseService) {}

  createBuilder(
    node: SegmentNode,
    config: BaseSegmentBuilderConfig,
  ): BaseSegmentBuilder {
    const { type } = node;

    switch (type) {
      case 'everyone':
      case 'Everyone':
        return new EveryoneSegmentBuilder(this.clickHouseService, config);

      case 'has_label':
      case 'not_has_label':
        return new LabelSegmentBuilder(this.clickHouseService, config);

      case 'custom_attribute':
        return new CustomAttributeSegmentBuilder(
          this.clickHouseService,
          config,
        );

      case 'user_property':
        return new UserPropertySegmentBuilder(this.clickHouseService, config);

      case 'performed':
      case 'lastPerformed':
        return new PerformedSegmentBuilder(this.clickHouseService, config);

      case 'Email':
        return new EmailSegmentBuilder(this.clickHouseService, config);

      case 'WhatsApp':
      case 'Web':
      case 'SMS':
        return new ChannelSegmentBuilder(this.clickHouseService, config);

      case 'RandomBucket':
        return new RandomBucketSegmentBuilder(this.clickHouseService, config);

      default:
        throw new Error(`Unsupported segment node type: ${type}`);
    }
  }
}
