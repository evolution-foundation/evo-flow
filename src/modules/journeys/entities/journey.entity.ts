import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

export interface FlowNode {
  id: string;
  type: string;
  position: {
    x: number;
    y: number;
  };
  data: any;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type?: string;
  data?: any;
}

export interface FlowData {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: {
    x: number;
    y: number;
    zoom: number;
  };
}

export enum TriggerType {
  Event = 'Event',
  Segment = 'Segment',
  Manual = 'Manual',
  Schedule = 'Schedule',
  Webhook = 'Webhook',
  ContactCreated = 'ContactCreated',
  ContactUpdated = 'ContactUpdated',
  Label = 'Label',
  CustomAttribute = 'CustomAttribute',
  PipelineStageChanged = 'PipelineStageChanged',
}

export interface TriggerCondition {
  field?: string;
  operator?: string;
  value?: any;
  eventName?: string;
  segmentId?: string;
  schedule?: string;
  webhookUrl?: string;
  labelId?: string;
  attributeName?: string;
}

export interface FlowTrigger {
  id: string;
  type: TriggerType;
  name: string;
  enabled: boolean;
  conditions?: TriggerCondition;
  metadata?: Record<string, any>;
}

@Entity('journeys')
export class Journey {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;

  @Column({ name: 'flow_data', type: 'jsonb', default: {} })
  flowData: FlowData;

  @Column({ name: 'flow_triggers', type: 'jsonb', default: [] })
  flowTriggers: FlowTrigger[];

  @Column({ name: 'variables', type: 'jsonb', default: [] })
  variables: any[];

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
