import { BaseNode, NodeExecutionResult } from './base.node';
import { getAppContext } from '../../../../shared/app-context.holder';
import { CrmClientService } from '../../../../shared/crm-client/crm-client.service';

export interface AddLabelNodeInput {
  nodeId: string;
  contactId: string;
  labelId: string;
  labelName?: string;
  sessionId: string;
  // EVO-1917: journeyId lets interpolateNodeData load journey-level variable
  // defaults so {{variables}} resolve in this node (mirrors send-webhook).
  journeyId?: string;
  nodeData: {
    labelId: string;
    nextNodeId?: string;
  };
}

export class AddLabelNode extends BaseNode {
  private labelsService: any = null;
  private contactsService: any = null;
  private crmService: CrmClientService;

  constructor() {
    super('AddLabel');
    this.crmService = new CrmClientService();
  }

  private async getServices() {
    const appContext = getAppContext();

    if (!this.labelsService) {
      const { LabelsService } = await import('../../../labels/labels.service');
      this.labelsService = appContext.get(LabelsService);
    }

    if (!this.contactsService) {
      const { ContactsService } = await import('../../../contacts/contacts.service');
      this.contactsService = appContext.get(ContactsService);
    }

    return {
      labelsService: this.labelsService,
      contactsService: this.contactsService
    };
  }

  async execute(input: AddLabelNodeInput): Promise<NodeExecutionResult> {
    return await this.executeWithTiming(input.nodeId, input, async () => {
      // Interpolate variables in node data
      const interpolatedNodeData = await this.interpolateNodeData(
        input,
        input.nodeData,
      );

      // Get services using lazy initialization
      const { labelsService, contactsService } = await this.getServices();

      try {

        // Use interpolated labelId from nodeData (this will resolve variables correctly)
        const labelId = interpolatedNodeData.labelId || input.labelId;

        // Q3-labels-service contract: addLabel(contactId, titleOrId).
        // Prefer the upstream labelName (title); fall back to labelId for
        // backward compat with callers that only carry the id.
        const labelNameOrId = input.labelName || labelId;

        this.logger.log('AddLabelNode execution started', {
          nodeId: input.nodeId,
          contactId: input.contactId,
          originalLabelId: input.labelId,
          interpolatedLabelId: labelId,
          nodeData: input.nodeData,
          interpolatedNodeData,
        });

        const contact: any = await contactsService.findById(input.contactId);

        if (!contact) {
          this.logger.warn(
            'AddLabelNode: contact not found',
            { contactId: input.contactId },
          );
          return { skipped: true, reason: 'contact_not_found' } as any;
        }

        await labelsService.addLabel(input.contactId, labelNameOrId);

        // EVO-1919 hardening: a 2xx from POST /contacts/:id/labels does NOT
        // guarantee the tagging persisted (D8 — CRM returned 200 without
        // writing). Re-read the contact (no-cache) and confirm the label is
        // actually present; fail the node when the effect is unconfirmed.
        const verification = await this.crmService.verifyEffect<any>(
          { nodeType: 'add-label', resourceId: input.contactId },
          () =>
            contactsService.findById(input.contactId, { noCache: true }),
          (contact: any) => {
            // The CRM ContactSerializer serializes a contact's labels as
            // { name, color } ONLY (no id/title) — see contact_serializer.rb
            // / _contact.json.jbuilder. addLabel posts the label *title* to
            // POST /contacts/:id/labels and the CRM keys labels by title, so
            // the serialized `name` equals the title we requested. Match by
            // `name`; `title` is tolerated only as a defensive fallback for
            // any alternate serialization. The previous `lbl.id`/`lbl.title`
            // checks were always false on the real shape → false negative
            // ("Label not persisted") after a genuine 2xx (EVO-1919 bug).
            const labels: Array<{ name?: string; title?: string }> =
              contact?.labels ?? [];
            return labels.some(
              (lbl) =>
                lbl?.name === labelNameOrId ||
                lbl?.name === input.labelName ||
                lbl?.title === labelNameOrId,
            );
          },
        );

        if (verification.verified && !verification.confirmed) {
          throw new Error(
            `Label not persisted: CRM accepted the request (2xx) but the ` +
              `tag "${labelNameOrId}" is absent on contact ${input.contactId} ` +
              `after re-read`,
          );
        }

        this.logger.log('Label added to contact successfully', {
          contactId: input.contactId,
          labelId: labelId,
          labelName: input.labelName ?? null,
          sessionId: input.sessionId,
          effectVerified: verification.verified,
        });

        return {
          labelAdded: true,
          labelId,
          labelName: input.labelName ?? null,
        };
      } catch (error) {
        this.logger.error('Failed to add label to contact', {
          contactId: input.contactId,
          originalLabelId: input.labelId,
          interpolatedLabelId: interpolatedNodeData?.labelId,
          nodeId: input.nodeId,
          error: error instanceof Error ? error.message : String(error),
          httpStatusCode: (error as any)?.response?.status,
        });
        throw error;
      }
    })
      .then(({ result, executionTime }) => {
        if (result?.skipped) {
          return this.createSkippedResult(result.reason, executionTime);
        }
        return this.createSuccessResult(input, executionTime, {
          [`node_${input.nodeId}_label_added`]: input.labelId,
          [`node_${input.nodeId}_label_name`]: result.labelName,
        });
      })
      .catch((error) => {
        const executionTime = Date.now();
        return this.createErrorResult(
          error instanceof Error ? error : new Error(String(error)),
          executionTime,
        );
      });
  }
}
