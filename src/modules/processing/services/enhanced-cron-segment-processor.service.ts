import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClickHouseService } from '../clickhouse/clickhouse.service';
import { Segment } from '../../segments/entities/segment.entity';
import { SegmentCacheService } from '../../cache/services/segment-cache.service';
import { SegmentComputationService } from '../../segments/services/segment-computation.service';
import { Inject, forwardRef } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RunMode } from '../enums/run-mode.enum';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

export interface SegmentFrequencyClassification {
  segmentId: string;
  frequency: 'REALTIME' | 'HIGH-FREQ' | 'MEDIUM-FREQ' | 'STANDARD';
  timeWindowMinutes?: number;
  cronExpression: string;
  lastProcessed?: Date;
  processingTimeMs?: number;
}

export interface CronProcessorStats {
  totalSegments: number;
  segmentsByFrequency: Record<string, number>;
  processedToday: number;
  averageProcessingTime: number;
  errors: number;
  lastProcessingCycle: Date;
}

interface SegmentFrequencyClassificationInternal {
  segmentId: string;
  frequency: 'REALTIME' | 'HIGH-FREQ' | 'MEDIUM-FREQ' | 'STANDARD';
  timeWindowMinutes?: number;
  cronExpression: string;
  lastProcessed?: Date;
  processingTimeMs?: number;
}

interface TimeWindowPattern {
  pattern: RegExp;
  extractMinutes: (match: RegExpMatchArray) => number;
  description: string;
}

@Injectable()
export class EnhancedCronSegmentProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new CustomLoggerService(
    EnhancedCronSegmentProcessor.name,
  );
  private segmentClassifications = new Map<
    string,
    SegmentFrequencyClassificationInternal
  >();
  private processingStats: CronProcessorStats = {
    totalSegments: 0,
    segmentsByFrequency: {},
    processedToday: 0,
    averageProcessingTime: 0,
    errors: 0,
    lastProcessingCycle: new Date(),
  };
  private isEnabled = false;

  private readonly timeWindowPatterns: TimeWindowPattern[] = [
    {
      pattern: /últimos?\s+(\d+)\s+minutos?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'Portuguese: últimos X minutos',
    },
    {
      pattern: /last\s+(\d+)\s+minutes?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'English: last X minutes',
    },
    {
      pattern: /nos?\s+últimos?\s+(\d+)\s+minutos?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'Portuguese: nos últimos X minutos',
    },
    {
      pattern: /recebid[ao]s?\s+nos?\s+últimos?\s+(\d+)\s+minutos?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'Portuguese: recebidas nos últimos X minutos',
    },
    {
      pattern: /within\s+(\d+)\s+minutes?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'English: within X minutes',
    },
    {
      pattern: /in\s+the\s+last\s+(\d+)\s+minutes?/gi,
      extractMinutes: (match) => parseInt(match[1]),
      description: 'English: in the last X minutes',
    },
    {
      pattern: /últim[ao]s?\s+(\d+)h/gi,
      extractMinutes: (match) => parseInt(match[1]) * 60,
      description: 'Portuguese: últimas X horas',
    },
    {
      pattern: /last\s+(\d+)\s+hours?/gi,
      extractMinutes: (match) => parseInt(match[1]) * 60,
      description: 'English: last X hours',
    },
  ];

  constructor(
    @InjectRepository(Segment)
    private segmentRepository: Repository<Segment>,
    private clickhouseService: ClickHouseService,
    private schedulerRegistry: SchedulerRegistry,
    private segmentCacheService: SegmentCacheService,
    @Inject(forwardRef(() => SegmentComputationService))
    private segmentComputationService: SegmentComputationService,
    private eventEmitter: EventEmitter2,
    private configService: ConfigService,
  ) {}

  async onModuleInit() {
    const runMode = this.configService.get<RunMode>('RUN_MODE', RunMode.SINGLE);
    const computationType = process.env.SEGMENT_COMPUTATION_TYPE || 'cron-job';

    // Only initialize in modes that handle segment processing
    if (runMode !== RunMode.SINGLE && runMode !== RunMode.SEGMENT_WORKER) {
      this.logger.log(
        `🎯 Enhanced CRON Segment Processor: Skipped (${runMode} mode - segment processing disabled)`,
      );
      return;
    }

    if (computationType === 'real-time') {
      this.logger.log(
        '🚀 SPRINT 3: Enhanced CRON Segment Processor initializing...',
      );
      this.isEnabled = true;
      await this.initializeSegmentClassification();
      await this.setupMultiFrequencySchedulers();
      this.logger.log('✅ Enhanced CRON system activated - Sprint 3 ready!');
    } else {
      this.logger.log(
        '⏸️ Enhanced CRON processor disabled (SEGMENT_COMPUTATION_TYPE=cron-job)',
      );
      this.logger.log('   Legacy segment-job system remains active');
    }
  }

  async onModuleDestroy() {
    if (this.isEnabled) {
      this.logger.log('🛑 Shutting down Enhanced CRON schedulers...');
      try {
        this.schedulerRegistry.deleteCronJob('realtime-segments');
        this.schedulerRegistry.deleteCronJob('high-freq-segments');
        this.schedulerRegistry.deleteCronJob('medium-freq-segments');
        this.schedulerRegistry.deleteCronJob('standard-segments');
      } catch (error) {
        this.logger.warn('Some schedulers were not found during shutdown');
      }
    }
  }

  private async initializeSegmentClassification() {
    this.logger.log('🔍 Analyzing segments for time-window classification...');

    const segments = await this.segmentRepository.find();

    let classified = 0;
    for (const segment of segments) {
      const classification = this.classifySegmentByTimeWindow(segment);
      this.segmentClassifications.set(segment.id, classification);
      classified++;
    }

    this.updateStatsAfterClassification();

    this.logger.log(`📊 Classified ${classified} segments:`);
    Object.entries(this.processingStats.segmentsByFrequency).forEach(
      ([freq, count]) => {
        this.logger.log(`   ${freq}: ${count} segments`);
      },
    );
  }

  private classifySegmentByTimeWindow(
    segment: Segment,
  ): SegmentFrequencyClassificationInternal {
    let timeWindowMinutes: number | undefined;

    // 🚀 FIRST: Check for JSON-based time windows (withinSeconds, withinMinutes, etc.)
    timeWindowMinutes = this.extractTimeWindowFromDefinition(
      segment.definition,
    );

    // 🔍 FALLBACK: Check text-based patterns if no JSON time window found
    if (!timeWindowMinutes) {
      const segmentText = `${segment.name || ''} ${JSON.stringify(segment.definition || {})}`;

      for (const pattern of this.timeWindowPatterns) {
        const match = pattern.pattern.exec(segmentText);
        if (match) {
          timeWindowMinutes = pattern.extractMinutes(match);
          this.logger.debug(
            `🎯 Time window detected via regex: ${timeWindowMinutes} minutes (${pattern.description})`,
          );
          break;
        }
        pattern.pattern.lastIndex = 0;
      }
    }

    if (timeWindowMinutes) {
      this.logger.debug(
        `🕐 Segment ${segment.name} classified with ${timeWindowMinutes}-minute time window`,
      );
    }

    let frequency: 'REALTIME' | 'HIGH-FREQ' | 'MEDIUM-FREQ' | 'STANDARD';
    let cronExpression: string;

    if (timeWindowMinutes) {
      if (timeWindowMinutes <= 5) {
        frequency = 'REALTIME';
        cronExpression = '*/1 * * * *'; // Every minute
      } else if (timeWindowMinutes <= 30) {
        frequency = 'HIGH-FREQ';
        cronExpression = '*/5 * * * *'; // Every 5 minutes
      } else if (timeWindowMinutes <= 180) {
        frequency = 'MEDIUM-FREQ';
        cronExpression = '*/15 * * * *'; // Every 15 minutes
      } else {
        frequency = 'STANDARD';
        cronExpression = '0 */1 * * *'; // Every hour
      }
    } else {
      // 🎯 USAR CRITÉRIOS DE COMPLEXIDADE DO ATOMIC (reutilizando lógica existente)
      const parsedDefinition = this.parseSegmentDefinition(segment.definition);
      const complexity = this.calculateComplexity(parsedDefinition);
      const classification = this.classifySegmentByComplexity(
        complexity,
        segment.contactsCount,
      );

      frequency = classification.frequency;
      cronExpression = classification.cronExpression;

      this.logger.debug(
        `Segment ${segment.id} without time-window: complexity=${complexity}, contacts=${segment.contactsCount}, frequency=${frequency}`,
      );
    }

    return {
      segmentId: segment.id,
      frequency,
      timeWindowMinutes,
      cronExpression,
      lastProcessed: undefined,
      processingTimeMs: undefined,
    };
  }

  /**
   * 🚀 NEW: Extract time windows from JSON definition structure
   * Detects: withinSeconds, withinMinutes, withinHours, withinDays
   */
  private extractTimeWindowFromDefinition(definition: any): number | undefined {
    if (!definition || typeof definition !== 'object') {
      return undefined;
    }

    try {
      // Recursively search through definition for time window fields
      const timeWindowMinutes = this.findTimeWindowRecursive(definition);

      if (timeWindowMinutes) {
        this.logger.debug(
          `🎯 Time window detected via JSON structure: ${timeWindowMinutes} minutes`,
        );
        return timeWindowMinutes;
      }
    } catch (error) {
      this.logger.debug(
        'Error parsing segment definition for time windows:',
        error,
      );
    }

    return undefined;
  }

  /**
   * Recursively search object for time window fields
   */
  private findTimeWindowRecursive(obj: any): number | undefined {
    if (!obj || typeof obj !== 'object') {
      return undefined;
    }

    // Check direct time window fields
    if (typeof obj.withinSeconds === 'number') {
      return Math.round(obj.withinSeconds / 60); // Convert to minutes
    }
    if (typeof obj.withinMinutes === 'number') {
      return obj.withinMinutes;
    }
    if (typeof obj.withinHours === 'number') {
      return obj.withinHours * 60; // Convert to minutes
    }
    if (typeof obj.withinDays === 'number') {
      return obj.withinDays * 24 * 60; // Convert to minutes
    }

    // Recursively check arrays and nested objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const result = this.findTimeWindowRecursive(item);
        if (result) return result;
      }
    } else {
      for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
          const result = this.findTimeWindowRecursive(obj[key]);
          if (result) return result;
        }
      }
    }

    return undefined;
  }

  private async setupMultiFrequencySchedulers() {
    this.logger.log('⏰ Setting up multi-frequency CRON schedulers...');

    const realtimeJob = new CronJob('*/1 * * * *', () =>
      this.processSegmentsByFrequency('REALTIME'),
    );
    const highFreqJob = new CronJob('*/5 * * * *', () =>
      this.processSegmentsByFrequency('HIGH-FREQ'),
    );
    const mediumFreqJob = new CronJob('*/15 * * * *', () =>
      this.processSegmentsByFrequency('MEDIUM-FREQ'),
    );
    const standardJob = new CronJob('0 */1 * * *', () =>
      this.processSegmentsByFrequency('STANDARD'),
    );

    this.schedulerRegistry.addCronJob('realtime-segments', realtimeJob);
    this.schedulerRegistry.addCronJob('high-freq-segments', highFreqJob);
    this.schedulerRegistry.addCronJob('medium-freq-segments', mediumFreqJob);
    this.schedulerRegistry.addCronJob('standard-segments', standardJob);

    realtimeJob.start();
    highFreqJob.start();
    mediumFreqJob.start();
    standardJob.start();

    this.logger.log('✅ All frequency schedulers started:');
    this.logger.log('   🔥 REALTIME: Every 1 minute (≤5min time windows)');
    this.logger.log('   ⚡ HIGH-FREQ: Every 5 minutes (6-30min time windows)');
    this.logger.log(
      '   🔄 MEDIUM-FREQ: Every 15 minutes (31-180min time windows)',
    );
    this.logger.log('   ⏱️ STANDARD: Every 1 hour (>180min or no time window)');
  }

  private async processSegmentsByFrequency(
    frequency: 'REALTIME' | 'HIGH-FREQ' | 'MEDIUM-FREQ' | 'STANDARD',
  ) {
    const startTime = Date.now();
    const segmentsToProcess = Array.from(
      this.segmentClassifications.values(),
    ).filter((classification) => classification.frequency === frequency);

    if (segmentsToProcess.length === 0) {
      return;
    }

    this.logger.log(
      `🚀 ${frequency} scheduler processing ${segmentsToProcess.length} segments...`,
    );

    let processedCount = 0;
    let errorCount = 0;

    for (const classification of segmentsToProcess) {
      try {
        await this.processSegmentWithCheckpoints(classification);

        classification.lastProcessed = new Date();
        classification.processingTimeMs = Date.now() - startTime;
        processedCount++;
      } catch (error) {
        errorCount++;
        this.logger.error(
          `❌ ${frequency} segment processing failed: ${classification.segmentId}`,
          error.message,
        );
      }
    }

    const totalTime = Date.now() - startTime;
    this.logger.log(
      `✅ ${frequency} cycle completed: ${processedCount}/${segmentsToProcess.length} segments (${totalTime}ms)`,
    );

    this.updateProcessingStats(processedCount, errorCount, totalTime);
  }

  private async processSegmentWithCheckpoints(
    classification: SegmentFrequencyClassification,
  ) {
    try {
      // 🎯 USAR A MESMA LÓGICA DO RECOMPUTE MANUAL!
      // Simplesmente chamar o computeSegment que já faz tudo certo
      this.logger.debug(
        `🔄 CRON triggering compute for segment ${classification.segmentId}`,
      );

      const result = await this.segmentComputationService.computeSegment(
        classification.segmentId,
      );

      this.logger.log(
        `✅ CRON compute completed for segment ${classification.segmentId}: ` +
          `${result.totalContacts} contacts, +${result.contactsAdded} -${result.contactsRemoved}`,
      );

      // Update classification metadata
      classification.lastProcessed = new Date();
      classification.processingTimeMs = result.processingTimeMs;
    } catch (error) {
      this.logger.error(
        `❌ CRON compute failed for segment ${classification.segmentId}:`,
        error.message,
      );
      throw error;
    }
  }

  // ✅ Métodos duplicados foram removidos - agora usa segmentComputationService.computeSegment()
  // que já implementa toda a lógica necessária de forma consolidada

  private updateProcessingStats(
    processedCount: number,
    errorCount: number,
    totalTimeMs: number,
  ) {
    this.processingStats.processedToday += processedCount;
    this.processingStats.errors += errorCount;
    this.processingStats.lastProcessingCycle = new Date();

    if (processedCount > 0) {
      const currentAvg = this.processingStats.averageProcessingTime || 0;
      this.processingStats.averageProcessingTime =
        (currentAvg + totalTimeMs / processedCount) / 2;
    }
  }

  private updateStatsAfterClassification() {
    this.processingStats.totalSegments = this.segmentClassifications.size;
    this.processingStats.segmentsByFrequency = {};

    for (const classification of this.segmentClassifications.values()) {
      const freq = classification.frequency;
      this.processingStats.segmentsByFrequency[freq] =
        (this.processingStats.segmentsByFrequency[freq] || 0) + 1;
    }
  }

  getProcessingStats(): CronProcessorStats {
    return {
      ...this.processingStats,
      segmentsByFrequency: { ...this.processingStats.segmentsByFrequency },
    };
  }

  getSegmentClassification(
    segmentId: string,
  ): SegmentFrequencyClassificationInternal | undefined {
    return this.segmentClassifications.get(segmentId);
  }

  async reclassifySegment(segmentId: string) {
    const segment = await this.segmentRepository.findOne({
      where: { id: segmentId },
    });

    if (segment) {
      const classification = this.classifySegmentByTimeWindow(segment);
      this.segmentClassifications.set(segmentId, classification);
      this.updateStatsAfterClassification();

      this.logger.log(
        `🔄 Reclassified segment ${segmentId} as ${classification.frequency}`,
      );
      return classification;
    }

    return undefined;
  }

  getSystemStatus() {
    return {
      enabled: this.isEnabled,
      computationType: process.env.SEGMENT_COMPUTATION_TYPE || 'cron-job',
      stats: this.getProcessingStats(),
      schedulers: {
        realtime: '*/1 * * * * (Every 1 minute)',
        highFreq: '*/5 * * * * (Every 5 minutes)',
        mediumFreq: '*/15 * * * * (Every 15 minutes)',
        standard: '0 */1 * * * (Every 1 hour)',
      },
      timeWindowPatterns: this.timeWindowPatterns.length,
      classification: {
        totalSegments: this.segmentClassifications.size,
        byFrequency: this.processingStats.segmentsByFrequency,
      },
    };
  }

  /**
   * 🎯 Parse segment definition (reutilizado do ATOMIC)
   */
  private parseSegmentDefinition(definition: any): any {
    if (typeof definition === 'string') {
      try {
        definition = JSON.parse(definition);
      } catch (error) {
        this.logger.warn('Failed to parse segment definition JSON', error);
        return { nodes: [], entryNode: { id: 'entry', type: 'Everyone' } };
      }
    }

    // Se já está no formato avançado, retorna
    if (definition && definition.nodes && definition.entryNode) {
      return definition;
    }

    // Fallback para formato simples
    return { nodes: [], entryNode: { id: 'entry', type: 'Everyone' } };
  }

  /**
   * 🎯 Calculate segment complexity (mesmo algoritmo do ATOMIC)
   */
  private calculateComplexity(definition: any): number {
    let complexity = 0;

    if (!definition || !definition.nodes) {
      return 0;
    }

    // Count nodes
    complexity += definition.nodes.length;

    // Add complexity for entry node type
    if (definition.entryNode) {
      switch (definition.entryNode.type) {
        case 'Everyone':
          complexity += 0; // Simple
          break;
        case 'And':
        case 'Or':
          complexity += definition.entryNode.children?.length || 0;
          break;
      }
    }

    // Add complexity for node types
    for (const node of definition.nodes) {
      switch (node.type) {
        case 'Performed':
          complexity += 2; // Medium complexity
          complexity += node.properties?.length || 0;
          break;
        case 'Label':
          complexity += 1; // Low complexity
          break;
        case 'Everyone':
          complexity += 0; // No complexity
          break;
        default:
          complexity += 1;
      }
    }

    return complexity;
  }

  /**
   * 🎯 Classify segment by complexity for segments WITHOUT time-windows
   * Baseado nos mesmos critérios do ATOMIC mas adaptado para CRON
   */
  private classifySegmentByComplexity(
    complexity: number,
    contactsCount: number,
  ): {
    frequency: 'REALTIME' | 'HIGH-FREQ' | 'MEDIUM-FREQ' | 'STANDARD';
    cronExpression: string;
  } {
    const hasLowComplexity = complexity <= 2;
    const hasSmallContactCount = contactsCount < 1000;
    const hasMediumContactCount = contactsCount < 10000;

    // Critérios baseados nos do ATOMIC (2 out of 3)
    const criteriaCount = [hasLowComplexity, hasSmallContactCount].filter(
      Boolean,
    ).length;

    if (criteriaCount >= 2) {
      // Segmentos simples e pequenos → frequência mais alta para rede de segurança
      return {
        frequency: 'HIGH-FREQ',
        cronExpression: '*/5 * * * *', // Every 5 minutes
      };
    } else if (hasLowComplexity || hasMediumContactCount) {
      // Segmentos médios → frequência padrão
      return {
        frequency: 'STANDARD',
        cronExpression: '0 */1 * * *', // Every 1 hour
      };
    } else {
      // Segmentos grandes/complexos → frequência baixa
      return {
        frequency: 'STANDARD',
        cronExpression: '0 0 */6 * *', // Every 6 hours
      };
    }
  }
}
