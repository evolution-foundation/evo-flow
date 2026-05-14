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
}
