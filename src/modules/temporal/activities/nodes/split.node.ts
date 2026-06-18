import { BaseNode, NodeExecutionResult } from './base.node';

export interface SplitNodeInput {
  nodeId: string;
  contactId: string;
  sessionId: string;
  nodeData: {
    variants?: Array<{
      id: string;
      name: string;
      percentage: number;
    }>;
    nextNodeId?: string;
  };
}

export class SplitNode extends BaseNode {
  constructor() {
    super('Split');
  }

  async execute(input: SplitNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Default split configuration (A/B test 50/50)
      const variants = input.nodeData.variants || [
        { id: 'variant-a', name: 'Variant A', percentage: 50 },
        { id: 'variant-b', name: 'Variant B', percentage: 50 },
      ];

      // Validate percentages sum to 100
      const totalPercentage = variants.reduce(
        (sum, v) => sum + v.percentage,
        0,
      );
      if (Math.abs(totalPercentage - 100) > 0.01) {
        throw new Error(
          `Split percentages must sum to 100, got ${totalPercentage}`,
        );
      }

      // Generate a random number between 0 and 100 for this contact
      // Use contact ID as seed for consistent routing
      const hash = this.hashString(input.contactId);
      const random = (hash % 10000) / 100; // 0-99.99

      // Determine which variant this contact falls into
      let cumulativePercentage = 0;
      let selectedVariant = variants[0];

      for (const variant of variants) {
        cumulativePercentage += variant.percentage;
        if (random < cumulativePercentage) {
          selectedVariant = variant;
          break;
        }
      }

      this.logger.log('Split node execution', {
        nodeId: input.nodeId,
        contactId: input.contactId,
        random,
        selectedVariant: selectedVariant.name,
        variantId: selectedVariant.id,
        variants: variants.map((v) => ({
          name: v.name,
          percentage: v.percentage,
        })),
      });

      // Determine the next node based on the variant
      // The flow builder should define handles for each variant
      const nextNodeHandle = `split-variant-${selectedVariant.id}`;

      return {
        selectedVariant: selectedVariant.name,
        variantId: selectedVariant.id,
        random,
        nextNodeHandle,
      };
    })
      .then(({ result, executionTime }) => {
        // EVO-1828: carry the routing decision so the executor branches to the
        // selected variant's edge (sourceHandle = split-variant-<id>) instead of
        // always falling back to the first edge.
        return {
          ...this.createSuccessResult(input, executionTime, {
            [`node_${input.nodeId}_selected_variant`]: result.selectedVariant,
            [`node_${input.nodeId}_variant_id`]: result.variantId,
            [`node_${input.nodeId}_random_value`]: result.random,
          }),
          nextNodeHandle: result.nextNodeHandle,
        };
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(error, executionTime);
      });
  }

  // Simple hash function for consistent routing
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
  }
}
