export enum RunMode {
  SINGLE = 'single', // Tudo junto - APIs + Workers (desenvolvimento/pequena escala)
  API = 'api', // Todas as APIs juntas (events + segments + journeys)
  EVENT_WORKER = 'event-worker', // Só worker de eventos
  SEGMENT_WORKER = 'segment-worker', // Só worker de segmentos
  TEMPORAL_WORKER = 'temporal-worker', // Só worker de Temporal (worker de Temporal)
  CAMPAIGN_WORKER = 'campaign-worker', // Worker dedicado para campanhas
  CAMPAIGN_PACKER = 'campaign-packer', // Audience materialization step of the campaign pipeline (EVO-1194)
  CAMPAIGN_SENDER = 'campaign-sender', // Dispatch step of the campaign pipeline (EVO-1194)
  CAMPAIGN_TRACKER = 'campaign-tracker', // Progress aggregation step of the campaign pipeline (EVO-1220)
  EVENT_RECEIVER = 'event-receiver', // Inbound webhook receiver that publishes to the broker (EVO-1194)
  EVENT_PROCESS = 'event-process', // Broker consumer that processes inbound events (EVO-1194)
}
