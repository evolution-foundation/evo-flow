import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  AfterUpdate,
  AfterInsert,
  AfterRemove,
} from 'typeorm';

export enum SegmentStatus {
  Running = 'Running',
  NotStarted = 'NotStarted',
}

export enum SegmentNodeType {
  // Legacy/Frontend types (backward compatibility)
  ContactField = 'ContactField',
  ContactStatus = 'ContactStatus',
  UserProperty = 'UserProperty',
  Email = 'Email',
  HasTag = 'HasTag',
  InSegment = 'InSegment',
  PropertyExists = 'PropertyExists',
  DateProperty = 'DateProperty',
  ListProperty = 'ListProperty',
  Performed = 'Performed',
  LastPerformed = 'LastPerformed',
  EmailEvent = 'EmailEvent',
  Subscription = 'Subscription',
  // Tipos compatíveis com sistema avançado
  Trait = 'Trait',
  And = 'And',
  Or = 'Or',
  Broadcast = 'Broadcast',
  SubscriptionGroup = 'SubscriptionGroup',
  Manual = 'Manual',
  RandomBucket = 'RandomBucket',
  KeyedPerformed = 'KeyedPerformed',
  Everyone = 'Everyone',
  BooleanProperty = 'BooleanProperty',
  WhatsApp = 'WhatsApp',
  Web = 'Web',
  SMS = 'SMS',
  Label = 'Label',
  CustomAttribute = 'CustomAttribute',
}

export enum SegmentOperatorType {
  // Basic operators
  Equals = 'Equals',
  NotEquals = 'NotEquals',
  GreaterThan = 'GreaterThan',
  GreaterThanOrEqual = 'GreaterThanOrEqual',
  LessThan = 'LessThan',
  LessThanOrEqual = 'LessThanOrEqual',
  // String operators
  Contains = 'Contains',
  NotContains = 'NotContains',
  StartsWith = 'StartsWith',
  EndsWith = 'EndsWith',
  // Existence operators
  Exists = 'Exists',
  NotExists = 'NotExists',
  IsNull = 'IsNull',
  IsNotNull = 'IsNotNull',
  HasValue = 'HasValue',
  DoesNotHaveValue = 'DoesNotHaveValue',
  // Collection operators
  In = 'In',
  NotIn = 'NotIn',
  ContainsAny = 'ContainsAny',
  ContainsAll = 'ContainsAll',
  // Time operators
  Before = 'Before',
  After = 'After',
  Between = 'Between',
  NotBetween = 'NotBetween',
  InLast = 'InLast',
  NotInLast = 'NotInLast',
  Within = 'Within',
  HasBeen = 'HasBeen',
  // Legacy subscription operators
  Subscribed = 'Subscribed',
  Unsubscribed = 'Unsubscribed',
}

export enum ResourceType {
  Declarative = 'Declarative',
  Internal = 'Internal',
}

export enum RelationalOperators {
  Equals = '=',
  GreaterThan = '>',
  GreaterThanOrEqual = '>=',
  LessThan = '<',
  LessThanOrEqual = '<=',
}

export enum TimeOperator {
  Before = 'before',
  After = 'after',
}

export interface SegmentOperator {
  type: SegmentOperatorType;
  value?: any;
}

// Frontend node types
export interface ContactFieldSegmentNode {
  type: SegmentNodeType.ContactField;
  id: string;
  field:
    | 'id'
    | 'name'
    | 'phoneNumber'
    | 'identifier'
    | 'createdAt'
    | 'updatedAt';
  operator: SegmentOperatorType;
  value: string;
}

export interface ContactStatusSegmentNode {
  type: SegmentNodeType.ContactStatus;
  id: string;
  status: 'active' | 'blocked';
}

export interface UserPropertySegmentNode {
  type: SegmentNodeType.UserProperty;
  id: string;
  path: string;
  operator: SegmentOperatorType;
  value: string | number | boolean;
}

export interface EmailSegmentNode {
  type: SegmentNodeType.Email;
  id: string;
  operator: SegmentOperatorType;
  value: string;
}

export interface HasTagSegmentNode {
  type: SegmentNodeType.HasTag;
  id: string;
  tagName: string;
}

export interface InSegmentSegmentNode {
  type: SegmentNodeType.InSegment;
  id: string;
  segmentId: string;
}

export interface PropertyExistsSegmentNode {
  type: SegmentNodeType.PropertyExists;
  id: string;
  path: string;
  exists: boolean;
}

export interface DatePropertySegmentNode {
  type: SegmentNodeType.DateProperty;
  id: string;
  path: string;
  operator: SegmentOperatorType;
  date?: string;
  startDate?: string;
  endDate?: string;
  daysAgo?: number;
}

export interface ListPropertySegmentNode {
  type: SegmentNodeType.ListProperty;
  id: string;
  path: string;
  operator: SegmentOperatorType;
  values: string[];
}

export interface EmailEventSegmentNode {
  type: SegmentNodeType.EmailEvent;
  id: string;
  event:
    | 'EmailOpened'
    | 'EmailClicked'
    | 'EmailDelivered'
    | 'EmailBounced'
    | 'EmailMarkedSpam';
  timesOperator?: SegmentOperatorType;
  times?: number;
  within?: string;
  campaignId?: string;
}

export interface SubscriptionSegmentNode {
  type: SegmentNodeType.Subscription;
  id: string;
  subscriptionGroup: string;
  operator: SegmentOperatorType;
}

// Backend node types
export interface TraitSegmentNode {
  type: SegmentNodeType.Trait;
  id: string;
  path: string;
  operator: SegmentOperator;
}

// Node types específicos
export interface RandomBucketSegmentNode {
  type: SegmentNodeType.RandomBucket;
  id: string;
  percent: number;
}

export interface SubscriptionGroupSegmentNode {
  type: SegmentNodeType.SubscriptionGroup;
  id: string;
  subscriptionGroupId: string;
  operator: SegmentOperator;
}

export interface LastPerformedSegmentNode {
  type: SegmentNodeType.LastPerformed;
  id: string;
  event: string;
  comparator: {
    operator: 'Before' | 'After';
    value: string; // ISO date or relative time
  };
  properties?: Array<{
    path: string;
    operator: SegmentOperator;
  }>;
}

export interface BooleanPropertySegmentNode {
  type: SegmentNodeType;
  id: string;
  path: string;
  operator: SegmentOperator; // { type: 'Equals', value: true/false }
}

export interface AndSegmentNode {
  type: SegmentNodeType.And;
  id: string;
  children: string[]; // IDs dos nós filhos
}

export interface OrSegmentNode {
  type: SegmentNodeType.Or;
  id: string;
  children: string[]; // IDs dos nós filhos
}

export interface PerformedSegmentNode {
  type: SegmentNodeType.Performed;
  id: string;
  event: string;
  times?: number;
  timesOperator?: '>=' | '<' | '=' | '>' | '<=' | '!=' | RelationalOperators; // Support both formats
  properties?: Array<{
    path: string;
    operator: SegmentOperator;
  }>;
  within?: {
    windowType: 'InLast';
    windowValue: string;
  };
  // Legacy support
  timeOperator?: TimeOperator;
  withinSeconds?: number;
  absoluteTimestamp?: string;
}

export interface ManualSegmentNode {
  type: SegmentNodeType.Manual;
  id: string;
  version: number;
}

export interface EveryoneSegmentNode {
  type: SegmentNodeType.Everyone;
  id: string;
}

export interface LabelSegmentNode {
  type: SegmentNodeType.Label;
  id: string;
  labelId: string;
  condition: 'has' | 'not_has';
}

export interface CustomAttributeSegmentNode {
  type: SegmentNodeType.CustomAttribute;
  id: string;
  attributeName: string;
  operator: SegmentOperator;
}

export type SegmentNode =
  // Legacy/Frontend types (backward compatibility)
  | ContactFieldSegmentNode
  | ContactStatusSegmentNode
  | UserPropertySegmentNode
  | EmailSegmentNode
  | HasTagSegmentNode
  | InSegmentSegmentNode
  | PropertyExistsSegmentNode
  | DatePropertySegmentNode
  | ListPropertySegmentNode
  | EmailEventSegmentNode
  | SubscriptionSegmentNode
  // Tipos compatíveis com sistema avançado
  | TraitSegmentNode
  | AndSegmentNode
  | OrSegmentNode
  | PerformedSegmentNode
  | ManualSegmentNode
  | EveryoneSegmentNode
  | RandomBucketSegmentNode
  | SubscriptionGroupSegmentNode
  | LastPerformedSegmentNode
  | BooleanPropertySegmentNode
  | LabelSegmentNode
  | CustomAttributeSegmentNode;

// Legacy frontend definition format (backward compatibility)
export interface LegacySegmentDefinition {
  type: 'And' | 'Or';
  children: SegmentNode[];
}

// Formato de definição avançado
export interface AdvancedSegmentDefinition {
  nodes: SegmentNode[];
  entryNode: AdvancedEntryNode;
}

export interface AdvancedEntryNode {
  id: string;
  type: 'And' | 'Or' | 'Everyone';
  children?: string[]; // IDs of other nodes
}

// Union type for compatibility
export type SegmentDefinition =
  | LegacySegmentDefinition
  | AdvancedSegmentDefinition;

// Type guards for definition types
export function isAdvancedDefinition(
  definition: any,
): definition is AdvancedSegmentDefinition {
  return (
    definition &&
    typeof definition === 'object' &&
    'nodes' in definition &&
    'entryNode' in definition
  );
}

export function isLegacyDefinition(
  definition: any,
): definition is LegacySegmentDefinition {
  return (
    definition &&
    typeof definition === 'object' &&
    'type' in definition &&
    'children' in definition
  );
}

@Entity('segments')
export class Segment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 255 })
  name: string;

  @Column('jsonb', { default: {} })
  definition: SegmentDefinition;

  @Column({ length: 50, default: 'running' })
  status: string;

  @Column({ name: 'computed_count', default: 0 })
  computedCount: number;

  @Column({ name: 'contacts_count', default: 0 })
  contactsCount: number;

  @Column({ name: 'version', default: 1 })
  version: number;

  @Column({ name: 'last_computed_at', type: 'timestamp', nullable: true })
  lastComputedAt?: Date;

  @Column({
    name: 'definition_updated_at',
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP',
  })
  definitionUpdatedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;

  /**
   * 🔄 TypeORM Listeners for automatic cache invalidation
   * Note: These methods will get access to services via global service locator
   */

  @AfterUpdate()
  async afterUpdate() {
    // Invalidate cache after segment update
    try {
      const { getSegmentCacheService, getEventEmitter } = await import(
        '../services/service-locator'
      );
      const segmentCacheService = getSegmentCacheService();
      const eventEmitter = getEventEmitter();

      if (segmentCacheService) {
        await segmentCacheService.invalidateSegment(this.id);
      }

      if (eventEmitter) {
        eventEmitter.emit('segment.updated', {
          segmentId: this.id,
        });
      }
    } catch (error) {
      console.warn('Failed to invalidate cache after segment update:', error);
    }
  }

  @AfterInsert()
  async afterInsert() {
    // Emit creation event after segment insert
    try {
      const { getEventEmitter } = await import('../services/service-locator');
      const eventEmitter = getEventEmitter();

      if (eventEmitter) {
        eventEmitter.emit('segment.created', {
          segmentId: this.id,
        });
      }
    } catch (error) {
      console.warn('Failed to emit segment creation event:', error);
    }
  }

  @AfterRemove()
  async afterRemove() {
    // Invalidate cache and emit deletion event after segment removal
    try {
      const { getSegmentCacheService, getEventEmitter } = await import(
        '../services/service-locator'
      );
      const segmentCacheService = getSegmentCacheService();
      const eventEmitter = getEventEmitter();

      if (segmentCacheService) {
        await segmentCacheService.invalidateSegment(this.id);
      }

      if (eventEmitter) {
        eventEmitter.emit('segment.deleted', {
          segmentId: this.id,
        });
      }
    } catch (error) {
      console.warn('Failed to invalidate cache after segment removal:', error);
    }
  }
}
