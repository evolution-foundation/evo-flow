import { EventClassification, EventPriority } from '../types/routing.types';
import {
  EMAIL_EVENTS,
  SMS_EVENTS,
  WHATSAPP_EVENTS,
  WEB_EVENTS,
  CAMPAIGN_EVENTS,
} from './event-names';

/**
 * Routing Configuration for Event Classification
 * Configurable event patterns for different classifications
 */

// Contact lifecycle events (conforme SEGMENT_ROUTING_STRATEGY_FINAL.md)
export const LIFECYCLE_EVENTS = {
  CONTACT_CREATED: 'contact_created',
  CONTACT_UPDATED: 'contact_updated',
  CONTACT_DELETED: 'contact_deleted',
  CONTACT_MERGED: 'contact_merged',
  SEGMENT_ENTERED: 'segment_entered',
  SEGMENT_EXITED: 'segment_exited',
  CUSTOM_ATTRIBUTE_CHANGED: 'custom_attribute_changed',
  // Canonical dotted name actually emitted by the CRM (EVO-1839). Required because
  // getEventClassification matches by substring, so the dotted form is not covered
  // by the legacy underscore entry above.
  CUSTOM_ATTRIBUTE_CHANGED_DOTTED: 'contact.custom_attribute.changed',
} as const;

// System events
export const SYSTEM_EVENTS = {
  GDPR_ERASURE_REQUEST: 'gdpr_erasure_request',
  DATA_EXPORT_REQUEST: 'data_export_request',
  INTEGRATION_SYNC: 'integration_sync',
  BULK_OPERATION: 'bulk_operation',
} as const;

// Standard behavioral events (core event types reais do sistema)
export const BEHAVIORAL_EVENTS = {
  TRACK: 'track',
  PAGE: 'page',
  IDENTIFY: 'identify',
  SCREEN: 'screen',
} as const;

/**
 * Event Classification Mapping
 * Maps event types to their classifications and default priorities
 */
export const EVENT_ROUTING_CONFIG = {
  [EventClassification.COMMUNICATION]: {
    classification: EventClassification.COMMUNICATION,
    defaultPriority: EventPriority.HIGH,
    events: [
      // Channel-specific events (conforme SEGMENT_ROUTING_STRATEGY_FINAL.md linha 49-53)
      'email', // Email events (sent, opened, clicked, etc.)
      'whatsapp', // WhatsApp events (sent, delivered, read, replied)
      'sms', // SMS events (sent, delivered, failed, replied)
      'web', // Web events (page views, form submissions, etc.)

      // Email events específicos ainda utilizados
      ...Object.values(EMAIL_EVENTS),
      // SMS events específicos
      ...Object.values(SMS_EVENTS),
      // WhatsApp events específicos
      ...Object.values(WHATSAPP_EVENTS),
      // Web events específicos
      ...Object.values(WEB_EVENTS),
    ],
  },

  [EventClassification.BEHAVIORAL]: {
    classification: EventClassification.BEHAVIORAL,
    defaultPriority: EventPriority.NORMAL,
    events: [
      // Standard behavioral events
      ...Object.values(BEHAVIORAL_EVENTS),
      // Web events
      ...Object.values(WEB_EVENTS),
      // Custom tracking events
      'custom_event',
      'api_event',
    ],
  },

  [EventClassification.LIFECYCLE]: {
    classification: EventClassification.LIFECYCLE,
    defaultPriority: EventPriority.HIGH,
    events: [
      // Contact lifecycle
      ...Object.values(LIFECYCLE_EVENTS),
      // Campaign events
      ...Object.values(CAMPAIGN_EVENTS),
    ],
  },

  [EventClassification.SYSTEM]: {
    classification: EventClassification.SYSTEM,
    defaultPriority: EventPriority.LOW,
    events: [
      // System events
      ...Object.values(SYSTEM_EVENTS),
      // Administrative events
      'admin_action',
      'system_maintenance',
      'data_cleanup',
    ],
  },
} as const;

/**
 * Critical Events Configuration - Based on SEGMENT_ROUTING_STRATEGY_FINAL.md
 * Events that require immediate processing regardless of complexity
 */
export const CRITICAL_EVENTS_CONFIG = {
  // Identificação e Onboarding Crítico (linha 582-584)
  identification: [
    LIFECYCLE_EVENTS.CONTACT_CREATED, // Novo contato = oportunidade crítica
    BEHAVIORAL_EVENTS.IDENTIFY, // Identificação de contato existente
    LIFECYCLE_EVENTS.CONTACT_UPDATED, // Mudanças importantes de perfil
  ],

  // Falhas de Comunicação - Crítico para deliverability (linha 587-591)
  communicationFailures: [
    EMAIL_EVENTS.BOUNCED, // Email bounced = problema crítico
    EMAIL_EVENTS.MARKED_AS_SPAM, // Marked as spam = reputação em risco
    'whatsapp_failed', // WhatsApp falhou = canal preferencial perdido
    SMS_EVENTS.FAILED, // SMS falhou = urgência não entregue
  ],

  // Engajamento Crítico Positivo (linha 593-597)
  criticalEngagement: [
    'email_replied', // Resposta por email = lead quente
    WHATSAPP_EVENTS.REPLIED, // Resposta WhatsApp = engajamento alto
    SMS_EVENTS.REPLIED, // Resposta SMS = urgente
    WEB_EVENTS.FORM_SUBMITTED, // Form submission = interesse direto
  ],

  // Mudanças de Status Críticas (linha 599-602)
  statusChanges: [
    LIFECYCLE_EVENTS.CUSTOM_ATTRIBUTE_CHANGED, // Mudança em atributos críticos
    LIFECYCLE_EVENTS.SEGMENT_ENTERED, // Entrada manual em segmento crítico
    LIFECYCLE_EVENTS.SEGMENT_EXITED, // Saída de segmento crítico
  ],

  // Comportamento de Alto Valor (linha 604-608)
  highValueBehavior: [
    'conversion_event', // Conversão realizada
    'high_value_action', // Ação de alto valor definida pelo usuário
    'subscription_change', // Mudança de assinatura/plano
    'payment_event', // Eventos relacionados a pagamento
  ],
} as const;

/**
 * High-Value Customer Indicators
 */
export const HIGH_VALUE_INDICATORS = {
  customerTiers: ['premium', 'enterprise', 'vip'],
  subscriptionTiers: ['enterprise', 'professional', 'premium'],
  valueThresholds: {
    high: 10000,
    medium: 1000,
    low: 100,
  },
  vipFlags: ['isVip', 'priority', 'highValue'],
} as const;

/**
 * Time-Sensitive Campaign Indicators
 */
export const TIME_SENSITIVE_INDICATORS = {
  campaignTypes: ['flash_sale', 'limited_offer', 'urgent', 'real_time'],
  urgencyFlags: ['immediate', 'urgent', 'time_sensitive'],
  eventPatterns: [
    'campaign_trigger',
    'automation_trigger',
    'abandoned',
    'reminder',
    'follow_up',
  ],
} as const;

/**
 * Impact Level Weights Configuration
 */
export const IMPACT_WEIGHTS = {
  eventType: {
    critical: 50,
    high: 40,
    medium: 25,
    low: 10,
  },
  segmentCount: {
    multiplier: 5,
    max: 30,
  },
  contactType: {
    customer: 20, // contactType = 2
    lead: 15, // contactType = 1
    visitor: 5, // contactType = 0
  },
  recency: {
    veryRecent: 15, // < 5 minutes
    recent: 10, // < 30 minutes
    moderate: 5, // < 2 hours
    old: 0, // > 2 hours
  },
  value: {
    veryHigh: 20, // > 10k
    high: 15, // > 1k
    medium: 10, // > 100
    low: 5, // > 0
    none: 0,
  },
} as const;

/**
 * Helper functions to work with the configuration
 */
export class EventRoutingConfigHelper {
  /**
   * Get all critical events as a flat array
   */
  static getAllCriticalEvents(): string[] {
    return Object.values(CRITICAL_EVENTS_CONFIG).flat();
  }

  /**
   * Get classification for an event type
   */
  static getEventClassification(eventType: string): EventClassification | null {
    const lowerEventType = eventType.toLowerCase();

    for (const [classification, config] of Object.entries(
      EVENT_ROUTING_CONFIG,
    )) {
      if (
        config.events.some((event) =>
          lowerEventType.includes(event.toLowerCase()),
        )
      ) {
        return classification as EventClassification;
      }
    }

    return null;
  }

  /**
   * Get default priority for an event type
   */
  static getDefaultPriority(eventType: string): EventPriority {
    const classification = this.getEventClassification(eventType);
    if (classification) {
      return EVENT_ROUTING_CONFIG[classification].defaultPriority;
    }
    return EventPriority.NORMAL;
  }

  /**
   * Check if event is critical
   */
  static isCriticalEvent(eventType: string): boolean {
    const lowerEventType = eventType.toLowerCase();
    return this.getAllCriticalEvents().some((critical) =>
      lowerEventType.includes(critical.toLowerCase()),
    );
  }

  /**
   * Check if customer is high value
   */
  static isHighValueCustomer(data: Record<string, any>): boolean {
    // Check customer tier
    if (
      data.customerTier &&
      HIGH_VALUE_INDICATORS.customerTiers.includes(data.customerTier)
    ) {
      return true;
    }

    // Check subscription tier
    if (
      data.subscription_tier &&
      HIGH_VALUE_INDICATORS.subscriptionTiers.includes(data.subscription_tier)
    ) {
      return true;
    }

    // Check monetary value
    const value = parseFloat(data.value || data.revenue || data.amount || '0');
    if (value > HIGH_VALUE_INDICATORS.valueThresholds.medium) {
      return true;
    }

    // Check VIP flags
    return HIGH_VALUE_INDICATORS.vipFlags.some((flag) => data[flag]);
  }

  /**
   * Check if event is time-sensitive
   */
  static isTimeSensitiveEvent(
    eventType: string,
    data: Record<string, any>,
  ): boolean {
    const lowerEventType = eventType.toLowerCase();

    // Check campaign types
    if (
      data.campaignType &&
      TIME_SENSITIVE_INDICATORS.campaignTypes.includes(data.campaignType)
    ) {
      return true;
    }

    // Check urgency flags
    if (
      data.urgency &&
      TIME_SENSITIVE_INDICATORS.urgencyFlags.includes(data.urgency)
    ) {
      return true;
    }

    // Check event patterns
    return TIME_SENSITIVE_INDICATORS.eventPatterns.some((pattern) =>
      lowerEventType.includes(pattern),
    );
  }
}

// Export all event types for type safety
export type CommunicationEventName =
  (typeof EVENT_ROUTING_CONFIG)[EventClassification.COMMUNICATION]['events'][number];
export type BehavioralEventName =
  (typeof EVENT_ROUTING_CONFIG)[EventClassification.BEHAVIORAL]['events'][number];
export type LifecycleEventName =
  (typeof EVENT_ROUTING_CONFIG)[EventClassification.LIFECYCLE]['events'][number];
export type SystemEventName =
  (typeof EVENT_ROUTING_CONFIG)[EventClassification.SYSTEM]['events'][number];

export type ConfigurableEventName =
  | CommunicationEventName
  | BehavioralEventName
  | LifecycleEventName
  | SystemEventName;
