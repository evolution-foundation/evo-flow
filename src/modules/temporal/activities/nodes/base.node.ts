import { log } from '@temporalio/activity';
import { CustomLoggerService } from 'src/common/services/custom-logger.service';
import {
  VariableInterpolationUtil,
  VariableContext,
} from '../utils/variable-interpolation.util';

export interface NodeExecutionResult {
  success: boolean;
  nextNodeId?: string;
  nextNodeHandle?: string; // Branch routing: the edge.sourceHandle the executor should follow (conditional/split nodes)
  error?: string;
  variables?: Record<string, any>;
  executionTime?: number;
  shouldPause?: boolean; // For wait nodes to signal workflow pause
  waitId?: string; // For wait nodes to provide wait ID
  metadata?: Record<string, any>; // For passing additional data to workflow
  skipped?: boolean; // Node could not run (missing required input) — surfaced as a visible failure, never as success
}

export abstract class BaseNode {
  protected readonly logger = new CustomLoggerService(this.constructor.name);

  constructor(
    protected readonly nodeType: string,
    protected readonly requiredContext: 'conversation' | 'contact' | 'none' = 'none',
  ) {}

  abstract execute(input: any): Promise<NodeExecutionResult>;

  protected async initializeDatabase() {
    const { AppDataSource } = await import('../../../../database/ormconfig');

    if (!AppDataSource.isInitialized) {
      await AppDataSource.initialize();
    }

    return AppDataSource;
  }

  protected logNodeStart(nodeId: string, input: any): void {
    // log.info(`Executing ${this.nodeType} node`, {
    //   nodeId,
    //   nodeType: this.nodeType,
    //   contactId: input.contactId,
    //
    //   sessionId: input.sessionId,
    // });
  }

  protected logNodeSuccess(
    nodeId: string,
    input: any,
    executionTime: number,
  ): void {
    // log.info(`${this.nodeType} node executed successfully`, {
    //   nodeId,
    //   nodeType: this.nodeType,
    //   contactId: input.contactId,
    //
    //   executionTime,
    // });
  }

  protected logNodeError(
    nodeId: string,
    input: any,
    error: Error,
    executionTime: number,
  ): void {
    log.error(`Failed to execute ${this.nodeType} node`, {
      nodeId,
      nodeType: this.nodeType,
      contactId: input.contactId,
      error: error.message,
      executionTime,
    });
  }

  protected createSuccessResult(
    input: any,
    executionTime: number,
    additionalVariables: Record<string, any> = {},
  ): NodeExecutionResult {
    const nodeId = input.nodeId;
    const baseVariables = {
      [`node_${nodeId}_executed`]: true,
      [`node_${nodeId}_execution_time`]: executionTime,
      [`node_${nodeId}_timestamp`]: new Date().toISOString(),
    };

    // Only specific node types should force a specific nextNodeId
    // Most nodes should let the workflow use edge navigation
    const nodeTypesToForceNextNode = [
      'exit-journey-node', 
      'transfer-journey-node',
      'conditional-node', // Conditional nodes may need to specify which branch to take
      'wait-node' // Wait nodes may need to specify fallback or completion routes
    ];
    
    const shouldForceNextNode = nodeTypesToForceNextNode.includes(this.nodeType);
    const finalNextNodeId = shouldForceNextNode ? input.nodeData?.nextNodeId : undefined;
    
    // log.info('🔍 DEBUG: BaseNode.createSuccessResult', {
    //   nodeId: input.nodeId,
    //   nodeType: this.nodeType,
    //   inputNextNodeId: input.nodeData?.nextNodeId,
    //   shouldForceNextNode,
    //   finalNextNodeId,
    //   nodeTypesToForceNextNode,
    // });

    return {
      success: true,
      nextNodeId: finalNextNodeId,
      executionTime,
      variables: {
        ...baseVariables,
        ...additionalVariables,
      },
    };
  }

  protected createErrorResult(
    error: Error,
    executionTime: number,
  ): NodeExecutionResult {
    return {
      success: false,
      error: `Failed to execute ${this.nodeType}: ${error.message}`,
      executionTime,
    };
  }

  // A node that cannot run because a required input is missing must NOT report
  // success (that would let the journey "complete" without acting — EVO-1740).
  // It is surfaced as a visible failure carrying the skip reason, so the
  // executor logs node_failed + telemetry and stops the journey.
  protected createSkippedResult(
    reason: string | undefined,
    executionTime: number,
  ): NodeExecutionResult {
    return {
      success: false,
      skipped: true,
      error: `${this.nodeType} skipped: ${reason ?? 'missing_required_input'}`,
      executionTime,
    };
  }

  // Trigger↔action contract (EVO-1741): a node declaring requiredContext
  // 'conversation' cannot run when the trigger provides no conversation (e.g.
  // a contact-only label trigger). Returns a visible skip result (checked as a
  // precondition before the node's work) so it fails with a clear reason
  // instead of letting an undefined conversationId reach the CRM as a murky error.
  //
  // CLEANUP (EVO-1741, defer to next node work): only the 7 "enforce" nodes call
  // contextSkip(). The 6 declare-only conversation nodes (send-message,
  // send-canned-response, send-email-team, assign-to-pipeline, create-pipeline-task,
  // move-to-pipeline-stage) still skip via the EVO-1740 inline guard, so their
  // `requiredContext: 'conversation'` is inert here — do NOT remove their inline
  // guard trusting this metadata. When next touching these nodes, unify them onto
  // contextSkip() and drop the currently-unused 'contact' branch of requiredContext.
  protected contextSkip(input: {
    conversationId?: string;
  }): NodeExecutionResult | null {
    if (this.requiredContext === 'conversation' && !input?.conversationId) {
      return this.createSkippedResult('no_conversation_id', 0);
    }
    return null;
  }

  protected async executeWithTiming<T>(
    nodeId: string,
    input: any,
    operation: () => Promise<T>,
  ): Promise<{ result: T; executionTime: number }> {
    const startTime = Date.now();

    try {
      this.logNodeStart(nodeId, input);
      const result = await operation();
      const executionTime = Date.now() - startTime;
      this.logNodeSuccess(nodeId, input, executionTime);

      return { result, executionTime };
    } catch (error) {
      const executionTime = Date.now() - startTime;
      this.logNodeError(nodeId, input, error as Error, executionTime);
      throw error;
    }
  }

  /**
   * Interpolates variables in node data using session and workflow variables
   */
  protected async interpolateNodeData(input: any, nodeData: any): Promise<any> {
    try {
      // Try cache first, then fallback to database
      const { journeyExecutionActivities } = await import('../journey-execution.activities');
      let session = await journeyExecutionActivities.getSessionFromCache(
        input.sessionId,
      );

      // If not in cache, load from database
      if (!session) {
        const dataSource = await this.initializeDatabase();
        const { JourneySession } = await import(
          '../../../journeys/entities/journey-session.entity'
        );
        const sessionRepository = dataSource.getRepository(JourneySession);

        session = await sessionRepository.findOne({
          where: { id: input.sessionId },
          relations: ['journey'],
        });
      }

      if (!session) {
        // EVO-1913: previously silent. Without a session we cannot resolve
        // {{variables}} and fall back to raw nodeData ({{var}} reaches the CRM
        // literally) — make that visible instead of swallowing it.
        this.logger.warn('Session not found for variable interpolation', {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
        });
        return nodeData;
      }

      // Load journey variables
      const dataSource = await this.initializeDatabase();
      const { Journey } = await import(
        '../../../journeys/entities/journey.entity'
      );
      const journeyRepository = dataSource.getRepository(Journey);
      // Most dispatch sites omit input.journeyId (EVO-1885); fall back to the
      // session's own journeyId (a scalar column present on both the cache and
      // DB session shapes) so journey-default {{variables}} resolve at every
      // node, not just the few that thread journeyId explicitly. Guard the query
      // on a resolved id: findOne({ where: { id: undefined } }) drops the
      // condition and would return an arbitrary journey's defaults.
      const journeyId = input.journeyId ?? session.journeyId;
      const journey = journeyId
        ? await journeyRepository.findOne({ where: { id: journeyId } })
        : null;

      const context: VariableContext = {
        sessionVariables: session.variables || {},
        workflowVariables: input.workflowState?.variables || {},
        variables: journey?.variables || [],
        contactId: input.contactId,
        sessionId: input.sessionId,
        timestamp: new Date().toISOString(),
      };

      // Interpolate the node data
      return VariableInterpolationUtil.interpolateVariables(nodeData, context);
    } catch (error) {
      // EVO-1913: this catch returned the raw nodeData with NO log, so a failed
      // interpolation silently shipped literal {{var}} tokens downstream (across
      // the ~17 executors that interpolate) with nothing to diagnose. Preserve
      // the graceful fallback but make the failure visible at ERROR level.
      this.logger.error('Failed to interpolate variables, using original data', {
        nodeId: input.nodeId,
        error: (error as Error)?.message,
      });
      return nodeData;
    }
  }
}
