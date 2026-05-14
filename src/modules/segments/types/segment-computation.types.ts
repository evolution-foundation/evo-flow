export interface SegmentNode {
  type: string;
  operator?: string;
  value?: any;
  children?: SegmentNode[];
  [key: string]: any;
}

export interface SegmentComputationContext {
  segmentId: string;
  node: SegmentNode;
}

export interface SegmentQueryResult {
  query: string;
  contactIds: string[];
}

export interface ContactExclusionOptions {
  excludeDeleted: boolean;
  excludeBlocked?: boolean;
}

export interface QueryTemplate {
  baseQuery: string;
  exclusionClauses: string[];
}

export type SegmentNodeType =
  | 'everyone'
  | 'has_label'
  | 'not_has_label'
  | 'customAttribute'
  | 'userProperty'
  | 'performed'
  | 'lastPerformed'
  | 'and'
  | 'or';

export interface BaseSegmentBuilderConfig {
  segmentId: string;
  exclusionOptions: ContactExclusionOptions;
}
