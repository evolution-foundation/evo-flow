export enum RunMode {
  SINGLE = 'single', // Tudo junto - APIs + Workers (desenvolvimento/pequena escala)
  API = 'api', // Todas as APIs juntas (events + segments + journeys)
  EVENT_WORKER = 'event-worker', // Só worker de eventos
  SEGMENT_WORKER = 'segment-worker', // Só worker de segmentos
  TEMPORAL_WORKER = 'temporal-worker', // Só worker de Temporal (worker de Temporal)
  CAMPAIGN_WORKER = 'campaign-worker', // Worker dedicado para campanhas
}
