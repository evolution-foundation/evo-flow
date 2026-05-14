/**
 * Utility for interpolating variables in journey node data
 * Supports {{variable_name}} syntax with fallback to default values
 */

export interface VariableContext {
  sessionVariables: Record<string, any>;
  workflowVariables: Record<string, any>;
  variables?: Array<{ name: string; defaultValue?: any }>;
  contactId: string;
  sessionId: string;
  timestamp: string;
}

export class VariableInterpolationUtil {
  /**
   * Interpolates variables in any data structure (string, object, array)
   */
  static interpolateVariables(data: any, context: VariableContext): any {
    if (typeof data === 'string') {
      return this.interpolateString(data, context);
    }
    
    if (Array.isArray(data)) {
      return data.map(item => this.interpolateVariables(item, context));
    }
    
    if (data && typeof data === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.interpolateVariables(value, context);
      }
      return result;
    }
    
    return data;
  }

  /**
   * Interpolates variables in a string using {{variable}} syntax
   */
  static interpolateString(text: string, context: VariableContext): string {
    return text.replace(/\{\{([^}]+)\}\}/g, (match, variablePath) => {
      const trimmedPath = variablePath.trim();
      
      // Try to resolve the variable value
      const resolvedValue = this.resolveVariable(trimmedPath, context);
      
      if (resolvedValue !== undefined) {
        return String(resolvedValue);
      }
      
      // Return original if not found
      return match;
    });
  }

  /**
   * Resolves a variable path to its value
   * Order of precedence: workflowVariables -> sessionVariables -> journeyDefaults -> systemVariables
   */
  static resolveVariable(variablePath: string, context: VariableContext): any {
    const pathParts = variablePath.split('.');
    
    // System variables
    if (pathParts[0] === 'contact') {
      return this.resolveSystemVariable(pathParts, context);
    }
    
    if (pathParts[0] === 'journey') {
      if (pathParts[1] === 'id') return context.sessionId;
      if (pathParts[1] === 'timestamp') return context.timestamp;
    }
    
    // Try workflow variables first (runtime variables set by nodes)
    const workflowValue = this.getNestedValue(context.workflowVariables, pathParts);
    if (workflowValue !== undefined) {
      return workflowValue;
    }
    
    // Try session variables (persistent variables)
    const sessionValue = this.getNestedValue(context.sessionVariables, pathParts);
    if (sessionValue !== undefined) {
      return sessionValue;
    }
    
    // Try journey variable defaults
    if (context.variables) {
      const journeyVar = context.variables.find(v => v.name === pathParts[0]);
      if (journeyVar && journeyVar.defaultValue !== undefined) {
        return journeyVar.defaultValue;
      }
    }
    
    return undefined;
  }

  /**
   * Resolves system variables like contact.id, contact.email
   */
  private static resolveSystemVariable(pathParts: string[], context: VariableContext): any {
    if (pathParts[0] === 'contact') {
      if (pathParts[1] === 'id') return context.contactId;
      // Additional contact properties would require contact data lookup
      // For now, return placeholder
      return `{{contact.${pathParts[1]}}}`;
    }
    
    return undefined;
  }

  /**
   * Gets nested value from object using dot notation path
   */
  private static getNestedValue(obj: any, pathParts: string[]): any {
    let current = obj;
    
    for (const part of pathParts) {
      if (current && typeof current === 'object' && part in current) {
        current = current[part];
      } else {
        return undefined;
      }
    }
    
    return current;
  }

  /**
   * Updates session variables in the database
   */
  static async updateSessionVariables(
    sessionId: string, 
    variables: Record<string, any>,
  ): Promise<void> {
    try {
      // Try cache first
      const { journeyExecutionActivities } = await import('../journey-execution.activities');
      let session = await journeyExecutionActivities.getSessionFromCache(sessionId);

      // If not in cache, load from database
      if (!session) {
        const { AppDataSource } = await import('../../../../database/ormconfig');
        const { JourneySession } = await import(
          '../../../journeys/entities/journey-session.entity'
        );

        if (!AppDataSource.isInitialized) {
          await AppDataSource.initialize();
        }

        const sessionRepository = AppDataSource.getRepository(JourneySession);
        session = await sessionRepository.findOne({
          where: { id: sessionId }
        });
      }

      if (session) {
        session.variables = { ...session.variables, ...variables };
        
        // Save to database
        const { AppDataSource } = await import('../../../../database/ormconfig');
        const { JourneySession } = await import(
          '../../../journeys/entities/journey-session.entity'
        );
        const sessionRepository = AppDataSource.getRepository(JourneySession);
        await sessionRepository.save(session);
        
        await journeyExecutionActivities.updateSessionInCache(session);
      }
    } catch (error) {
      console.error('Failed to update session variables:', error);
    }
  }
}