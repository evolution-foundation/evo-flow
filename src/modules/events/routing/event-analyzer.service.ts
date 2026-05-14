import { Injectable } from '@nestjs/common';
import {
  ProcessingEvent,
  EventPriority,
  IEventAnalyzer,
} from '../types/routing.types';
import {
  EventRoutingConfigHelper,
  IMPACT_WEIGHTS,
} from '../constants/routing-config';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';

/**
 * Event Analyzer Service - Analyzes CRM events for business criticality and impact
 * Focuses on communication and customer lifecycle events
 */
@Injectable()
export class EventAnalyzerService implements IEventAnalyzer {
  private readonly logger = new CustomLoggerService(EventAnalyzerService.name);

  /**
   * Determine event priority based on CRM business impact
   */
  async determineEventPriority(
    event: ProcessingEvent,
    affectedSegmentsCount: number,
  ): Promise<EventPriority> {
    try {
      // Step 1: Check if it's a critical CRM business event
      if (this.isCriticalBusinessEvent(event)) {
        return EventPriority.CRITICAL;
      }

      // Step 2: Calculate impact level based on CRM event characteristics
      const impactLevel = this.calculateImpactLevel(
        event,
        affectedSegmentsCount,
      );

      // Step 3: Map impact level to priority
      return this.mapImpactToPriority(impactLevel);
    } catch (error) {
      this.logger.error(
        `Error determining CRM event priority: ${error.message}`,
        error.stack,
      );
      return EventPriority.NORMAL; // Safe fallback
    }
  }

  /**
   * Check if event is critical for CRM business operations
   * Uses configurable event definitions
   */
  isCriticalBusinessEvent(event: ProcessingEvent): boolean {
    // Check if event is in critical events configuration
    if (EventRoutingConfigHelper.isCriticalEvent(event.type)) {
      return true;
    }

    // Check for high-value customer actions
    if (EventRoutingConfigHelper.isHighValueCustomer(event.data || {})) {
      return true;
    }

    // Check for time-sensitive campaign events
    if (
      EventRoutingConfigHelper.isTimeSensitiveEvent(
        event.type,
        event.data || {},
      )
    ) {
      return true;
    }

    return false;
  }

  /**
   * Calculate impact level (0-100) for CRM events
   */
  calculateImpactLevel(
    event: ProcessingEvent,
    affectedSegmentsCount: number,
  ): number {
    let impact = 0;

    // Base impact from CRM event type
    impact += this.getCRMEventTypeBaseImpact(event.type);

    // Impact from affected segments count
    impact += Math.min(affectedSegmentsCount * 5, 30); // Max 30 points

    // Impact from contact type (CRM specific)
    impact += this.getContactTypeImpact(event);

    // Impact from event recency
    impact += this.getRecencyImpact(event.timestamp);

    // Impact from CRM value indicators
    impact += this.getCRMValueImpact(event);

    return Math.min(impact, 100); // Cap at 100
  }

  /**
   * Map impact level to priority enum
   */
  private mapImpactToPriority(impactLevel: number): EventPriority {
    if (impactLevel >= 80) return EventPriority.CRITICAL;
    if (impactLevel >= 60) return EventPriority.HIGH;
    if (impactLevel >= 30) return EventPriority.NORMAL;
    return EventPriority.LOW;
  }

  /**
   * Check if event is from a high-value customer
   */
  private isHighValueCustomerEvent(event: ProcessingEvent): boolean {
    const data = event.data || {};

    // Customer tier indicators
    if (data.customerTier === 'premium' || data.customerTier === 'enterprise') {
      return true;
    }

    // High monetary value
    if (data.value && parseFloat(data.value) > 1000) {
      return true;
    }

    // VIP contact indicators
    if (data.isVip || data.priority === 'high') {
      return true;
    }

    return false;
  }

  /**
   * Check if event is part of time-sensitive campaign
   */
  private isTimeSensitiveCampaignEvent(event: ProcessingEvent): boolean {
    const data = event.data || {};
    const eventType = event.type.toLowerCase();

    // Real-time campaign triggers
    if (
      eventType.includes('campaign_trigger') ||
      eventType.includes('automation_trigger')
    ) {
      return true;
    }

    // Time-sensitive promotional events
    if (data.campaignType === 'flash_sale' || data.urgency === 'immediate') {
      return true;
    }

    // Abandoned cart or similar urgent follow-ups
    if (eventType.includes('abandoned') || eventType.includes('reminder')) {
      return true;
    }

    return false;
  }

  /**
   * Get base impact score from CRM event type using configuration
   */
  private getCRMEventTypeBaseImpact(eventType: string): number {
    // Check if it's a critical event
    if (EventRoutingConfigHelper.isCriticalEvent(eventType)) {
      return IMPACT_WEIGHTS.eventType.critical;
    }

    // Get event classification and assign impact based on type
    const classification =
      EventRoutingConfigHelper.getEventClassification(eventType);

    switch (classification?.toLowerCase()) {
      case 'communication':
        return IMPACT_WEIGHTS.eventType.high;
      case 'lifecycle':
        return IMPACT_WEIGHTS.eventType.high;
      case 'behavioral':
        return IMPACT_WEIGHTS.eventType.medium;
      case 'system':
        return IMPACT_WEIGHTS.eventType.low;
      default:
        return IMPACT_WEIGHTS.eventType.low;
    }
  }

  /**
   * Get impact based on contact type using configuration
   */
  private getContactTypeImpact(event: ProcessingEvent): number {
    const data = event.data || {};

    // Contact type from event data (matches Contact entity enum)
    if (data.contactType === 2) return IMPACT_WEIGHTS.contactType.customer; // CUSTOMER = 2
    if (data.contactType === 1) return IMPACT_WEIGHTS.contactType.lead; // LEAD = 1
    if (data.contactType === 0) return IMPACT_WEIGHTS.contactType.visitor; // VISITOR = 0

    // Fallback to contact stage indicators
    if (data.stage === 'customer' || data.lifecycle_stage === 'customer')
      return IMPACT_WEIGHTS.contactType.customer;
    if (data.stage === 'lead' || data.lifecycle_stage === 'lead')
      return IMPACT_WEIGHTS.contactType.lead;

    return IMPACT_WEIGHTS.contactType.visitor; // Default for unknown contact types
  }

  /**
   * Get impact based on event recency using configuration
   */
  private getRecencyImpact(timestamp: number): number {
    const now = Date.now();
    const ageMs = now - timestamp;
    const ageMinutes = ageMs / (1000 * 60);

    // More recent events have higher impact using configured weights
    if (ageMinutes < 5) return IMPACT_WEIGHTS.recency.veryRecent; // Very recent
    if (ageMinutes < 30) return IMPACT_WEIGHTS.recency.recent; // Recent
    if (ageMinutes < 120) return IMPACT_WEIGHTS.recency.moderate; // Moderately recent
    return IMPACT_WEIGHTS.recency.old; // Older events
  }

  /**
   * Get impact based on CRM value indicators using configuration
   */
  private getCRMValueImpact(event: ProcessingEvent): number {
    const data = event.data || {};

    // Monetary value indicators using configured thresholds
    if (data.revenue || data.value || data.amount) {
      const value = parseFloat(
        data.revenue || data.value || data.amount || '0',
      );

      if (value > IMPACT_WEIGHTS.value.veryHigh)
        return IMPACT_WEIGHTS.value.veryHigh;
      if (value > IMPACT_WEIGHTS.value.high) return IMPACT_WEIGHTS.value.high;
      if (value > IMPACT_WEIGHTS.value.medium)
        return IMPACT_WEIGHTS.value.medium;
      if (value > 0) return IMPACT_WEIGHTS.value.low;
    }

    // Use high-value customer helper from configuration
    if (EventRoutingConfigHelper.isHighValueCustomer(data)) {
      return IMPACT_WEIGHTS.value.high;
    }

    return IMPACT_WEIGHTS.value.none; // No monetary value detected
  }

  /**
   * Get event urgency score for CRM context
   */
  getEventUrgency(event: ProcessingEvent): number {
    let urgency = 0;

    // Time-sensitive campaign events
    if (this.isTimeSensitiveCampaignEvent(event)) urgency += 30;

    // Real-time communication events
    if (this.isCommunicationEvent(event.type)) urgency += 20;

    // Customer engagement events
    if (this.isCustomerEngagementEvent(event.type)) urgency += 25;

    return Math.min(urgency, 100);
  }

  /**
   * Check if event is communication-related
   */
  private isCommunicationEvent(eventType: string): boolean {
    const type = eventType.toLowerCase();
    return (
      type.includes('email') ||
      type.includes('whatsapp') ||
      type.includes('sms') ||
      type.includes('notification')
    );
  }

  /**
   * Check if event represents customer engagement
   */
  private isCustomerEngagementEvent(eventType: string): boolean {
    const type = eventType.toLowerCase();
    return (
      type.includes('click') ||
      type.includes('open') ||
      type.includes('reply') ||
      type.includes('conversion')
    );
  }
}
