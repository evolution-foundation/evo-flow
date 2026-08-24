import { SegmentNode } from '../types/segment-computation.types';

export class SegmentQueryUtils {
  /**
   * Combines multiple contact ID arrays with AND operation (intersection)
   */
  static combineWithAnd(contactIdArrays: string[][]): string[] {
    if (contactIdArrays.length === 0) return [];
    if (contactIdArrays.length === 1) return contactIdArrays[0];

    return contactIdArrays.reduce((intersection, current) => {
      return intersection.filter((contactId) => current.includes(contactId));
    });
  }

  /**
   * Combines multiple contact ID arrays with OR operation (union)
   */
  static combineWithOr(contactIdArrays: string[][]): string[] {
    const uniqueContactIds = new Set<string>();

    contactIdArrays.forEach((array) => {
      array.forEach((contactId) => uniqueContactIds.add(contactId));
    });

    return Array.from(uniqueContactIds);
  }

  /**
   * Excludes contact IDs from the first array that exist in the second array
   */
  static excludeContacts(
    includeContactIds: string[],
    excludeContactIds: string[],
  ): string[] {
    return includeContactIds.filter(
      (contactId) => !excludeContactIds.includes(contactId),
    );
  }

  /**
   * Validates segment node structure recursively
   */
  static validateSegmentStructure(node: SegmentNode): void {
    if (!node.type) {
      throw new Error('Segment node must have a type');
    }

    if (node.type === 'and' || node.type === 'or') {
      if (
        !node.children ||
        !Array.isArray(node.children) ||
        node.children.length === 0
      ) {
        throw new Error(
          `${node.type} node must have children array with at least one child`,
        );
      }

      node.children.forEach((child) => this.validateSegmentStructure(child));
    }
  }

  /**
   * Counts total leaf nodes in segment tree
   */
  static countLeafNodes(node: SegmentNode): number {
    if (node.type === 'and' || node.type === 'or') {
      if (!node.children) return 0;
      return node.children.reduce(
        (count, child) => count + this.countLeafNodes(child),
        0,
      );
    }

    return 1;
  }

  /**
   * Sanitizes string values for SQL queries (basic SQL injection prevention)
   */
  static sanitizeStringValue(value: string): string {
    if (typeof value !== 'string') {
      return String(value);
    }

    return value.replace(/'/g, "''").replace(/\\/g, '\\\\');
  }

  /**
   * Gets all unique node types from segment tree
   */
  static getNodeTypes(node: SegmentNode): Set<string> {
    const types = new Set<string>();
    types.add(node.type);

    if (node.children) {
      node.children.forEach((child) => {
        const childTypes = this.getNodeTypes(child);
        childTypes.forEach((type) => types.add(type));
      });
    }

    return types;
  }

  /**
   * Estimates query complexity based on node structure
   */
  static estimateComplexity(node: SegmentNode): number {
    const leafCount = this.countLeafNodes(node);
    const depth = this.getMaxDepth(node);

    return leafCount * depth;
  }

  /**
   * Gets maximum depth of segment tree
   */
  static getMaxDepth(node: SegmentNode): number {
    if (!node.children || node.children.length === 0) {
      return 1;
    }

    const childDepths = node.children.map((child) => this.getMaxDepth(child));
    return 1 + Math.max(...childDepths);
  }

  /**
   * LIKE treats %, _ and \ specially; escape them so a user value only ever
   * matches itself as a substring.
   */
  static sanitizeLikeValue(value: unknown): string {
    return this.sanitizeStringValue(
      String(value ?? '').replace(/[\\%_]/g, (ch) => `\\${ch}`),
    );
  }

  /**
   * Non-finite input becomes the literal `null` instead of raw text, so an
   * unquoted numeric comparison can't splice in arbitrary SQL.
   */
  static sanitizeNumericValue(value: unknown): string {
    const num = Number(value);
    return Number.isFinite(num) ? String(num) : 'null';
  }

  /**
   * CRM-241: an event property can arrive in either column. Contact events are
   * emitted as `identify`, so the payload lands in `traits` and `properties`
   * stays `{}`. Prefer `properties` and fall back only when the key is absent,
   * so `track` events keep the SQL they had before. JSONHas rather than
   * `!= ''`: a present-but-empty key is a real answer, and falling back on it
   * would break NotExists.
   */
  static extractEventProperty(path: unknown, alias = ''): string {
    const prefix = alias ? `${alias}.` : '';
    const key = this.sanitizeStringValue(String(path ?? ''));
    return (
      `JSONExtractString(if(JSONHas(${prefix}properties, '${key}'), ` +
      `${prefix}properties, ${prefix}traits), '${key}')`
    );
  }

  /**
   * The single event-property filter every segment builder emits. It lives here
   * because the copies in the query builder and in the processing module had
   * already drifted apart, each with its own operator list.
   */
  static buildEventPropertyCondition(
    prop: any,
    alias = '',
    onUnknownOperator?: (operator: string, path: unknown) => void,
  ): string {
    const value = prop?.operator?.value || '';
    const operator = prop?.operator?.type || 'Equals';
    const extract = this.extractEventProperty(prop?.path, alias);
    const escapedValue = this.sanitizeStringValue(String(value ?? ''));
    const likeValue = this.sanitizeLikeValue(value);
    const numericValue = this.sanitizeNumericValue(value);

    switch (operator) {
      case 'Equals':
        return `${extract} = '${escapedValue}'`;
      case 'NotEquals':
        return `${extract} != '${escapedValue}'`;
      case 'Contains':
        return `${extract} LIKE '%${likeValue}%'`;
      case 'NotContains':
        return `${extract} NOT LIKE '%${likeValue}%'`;
      case 'GreaterThan':
        return `toFloat64OrNull(${extract}) > ${numericValue}`;
      case 'GreaterThanOrEqual':
        return `toFloat64OrNull(${extract}) >= ${numericValue}`;
      case 'LessThan':
        return `toFloat64OrNull(${extract}) < ${numericValue}`;
      case 'LessThanOrEqual':
        return `toFloat64OrNull(${extract}) <= ${numericValue}`;
      case 'Exists':
        return `${extract} != ''`;
      case 'NotExists':
        return `${extract} = ''`;
      default:
        // Unknown operator still degrades to equality, but no longer silently.
        onUnknownOperator?.(operator, prop?.path);
        return `${extract} = '${escapedValue}'`;
    }
  }
}
