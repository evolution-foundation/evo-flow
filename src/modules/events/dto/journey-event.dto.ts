import { IsString, IsOptional, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseEventDto } from './base-event.dto';

export enum JourneyEventType {
  JOURNEY_STARTED = 'journey_started',
  JOURNEY_COMPLETED = 'journey_completed',
  JOURNEY_FAILED = 'journey_failed',
  JOURNEY_PAUSED = 'journey_paused',
  JOURNEY_RESUMED = 'journey_resumed',
  NODE_STARTED = 'node_started',
  NODE_COMPLETED = 'node_completed',
  NODE_FAILED = 'node_failed',
  NODE_TRANSITION = 'node_transition',
  CONDITIONAL_EVALUATION = 'conditional_evaluation',
  WAIT_STARTED = 'wait_started',
  WAIT_COMPLETED = 'wait_completed',
  WAIT_TIMEOUT = 'wait_timeout',
  WAIT_CANCELLED = 'wait_cancelled',
}

export class JourneyEventDto extends BaseEventDto {
  @ApiProperty({
    description: 'Journey event type',
    enum: JourneyEventType,
    example: JourneyEventType.JOURNEY_STARTED,
  })
  @IsEnum(JourneyEventType)
  event: JourneyEventType;

  @ApiProperty({
    description: 'Journey ID',
    example: 'journey_123',
  })
  @IsString()
  journeyId: string;

  @ApiProperty({
    description: 'Journey session ID',
    example: 'session_456',
  })
  @IsString()
  sessionId: string;

  @ApiPropertyOptional({
    description: 'Temporal workflow ID',
    example: 'workflow_789',
  })
  @IsOptional()
  @IsString()
  workflowId?: string;

  @ApiPropertyOptional({
    description: 'Node ID (for node-specific events)',
    example: 'node_abc',
  })
  @IsOptional()
  @IsString()
  nodeId?: string;

  @ApiPropertyOptional({
    description: 'Node type (for node-specific events)',
    example: 'conditional-node',
  })
  @IsOptional()
  @IsString()
  nodeType?: string;

  @ApiPropertyOptional({
    description: 'Journey execution properties and metrics',
    example: {
      execution_time_ms: 1500,
      status: 'completed',
      result: { success: true },
      error_message: null,
      metadata: { version: '1.0' },
    },
  })
  @IsOptional()
  @IsObject()
  properties?: {
    // Journey-level properties
    journey_id?: string;
    session_id?: string;
    workflow_id?: string;
    
    // Execution properties
    execution_time_ms?: number;
    total_execution_time_ms?: number;
    status?: string;
    final_status?: string;
    result?: any;
    error_message?: string;
    
    // Node properties
    node_id?: string;
    node_type?: string;
    completed_nodes?: string[];
    total_nodes_executed?: number;
    nodes_completed_before_failure?: number;
    
    // Transition properties
    from_node_id?: string;
    from_node_type?: string;
    to_node_id?: string;
    to_node_type?: string;
    transition_handle?: string;
    transition_reason?: string;
    
    // Conditional properties
    paths_evaluated?: number;
    selected_path_id?: string;
    selected_path_name?: string;
    path_evaluations?: Array<{
      pathId: string;
      pathName: string;
      conditions: any[];
      matched: boolean;
      evaluationTime: number;
    }>;
    
    // Wait properties
    wait_type?: string;
    actual_wait_duration_ms?: number;
    expected_duration_ms?: number;
    completion_trigger?: string;
    
    // Trigger properties
    trigger_event?: string;
    trigger_type?: string;
    
    // Timestamps
    started_at?: string;
    completed_at?: string;
    failed_at?: string;
    transitioned_at?: string;
    evaluated_at?: string;
    
    // Additional metadata
    metadata?: Record<string, any>;
    
    [key: string]: any;
  };
}

export class JourneyPerformanceEventDto extends BaseEventDto {
  @ApiProperty({
    description: 'Journey performance event type',
    example: 'journey_performance_metrics',
  })
  @IsString()
  event: string;

  @ApiProperty({
    description: 'Journey ID',
    example: 'journey_123',
  })
  @IsString()
  journeyId: string;

  @ApiPropertyOptional({
    description: 'Performance metrics and analytics',
    example: {
      total_executions: 150,
      success_rate: 0.95,
      average_execution_time_ms: 2500,
      most_common_failure_node: 'conditional_abc',
      path_distribution: {
        'path_1': 0.60,
        'path_2': 0.25,
        'else': 0.15,
      },
    },
  })
  @IsOptional()
  @IsObject()
  properties?: {
    // Performance metrics
    total_executions?: number;
    success_rate?: number;
    failure_rate?: number;
    average_execution_time_ms?: number;
    median_execution_time_ms?: number;
    p95_execution_time_ms?: number;
    
    // Node performance
    slowest_node_type?: string;
    most_common_failure_node?: string;
    node_performance_metrics?: Record<string, {
      average_time_ms: number;
      success_rate: number;
      total_executions: number;
    }>;
    
    // Path analytics
    path_distribution?: Record<string, number>;
    conditional_path_analytics?: Record<string, {
      selection_rate: number;
      average_evaluation_time_ms: number;
    }>;
    
    // Time-based metrics
    hourly_execution_distribution?: Record<string, number>;
    daily_success_rate?: Record<string, number>;
    
    // Contact analytics
    unique_contacts_executed?: number;
    repeat_execution_rate?: number;
    
    [key: string]: any;
  };
}