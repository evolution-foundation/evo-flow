import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ApiProcessingService } from './api-processing.service';
import { ApiProcessingController } from './api-processing.controller';
import { KafkaService } from './kafka/kafka.service';
import { ProcessingService } from './processing.service';

/**
 * Módulo de processamento simplificado para modo API
 * Contém apenas o necessário para enviar eventos para Kafka
 */
@Module({
  imports: [ConfigModule],
  controllers: [ApiProcessingController],
  providers: [
    KafkaService, // Apenas producer
    ApiProcessingService, // Service simplificado
    {
      provide: ProcessingService,
      useExisting: ApiProcessingService, // Alias para compatibilidade
    },
  ],
  exports: [
    ProcessingService,
    ApiProcessingService,
    KafkaService,
  ],
})
export class ApiProcessingModule {}