import type { LabelDto } from './label';

/**
 * Contact DTO exposed by evo-ai-crm-community (Rails) REST API.
 *
 * Wire format is snake_case (Rails JBuilder). Fields reflect the actual
 * response of `GET /api/v1/contacts/{id}` (see app/views/api/v1/models/
 * _contact.json.jbuilder). Use `mapContactDto` to convert to the camelCase
 * shape consumed by evo-flow business code.
 */
export interface ContactDto {
  id: string;
  name?: string;
  email?: string;
  phone_number?: string | null;
  blocked?: boolean;
  identifier?: string | null;
  thumbnail?: string | null;
  availability_status?: string;
  custom_attributes?: Record<string, unknown>;
  additional_attributes?: Record<string, unknown>;
  /**
   * Unix timestamps (seconds) per Rails JBuilder. Convert to Date when
   * mapping into the in-memory shape.
   */
  last_activity_at?: number | null;
  created_at?: number | null;
  labels?: LabelDto[];
}

/**
 * In-memory representation of a contact used by evo-flow services. CamelCase
 * to match prior `Contact` entity shape so existing business logic
 * (validateContactForChannel, processTemplateVariables, audience filters) keeps
 * the same access patterns.
 *
 * Built from `ContactDto` via `mapContactDto`.
 */
export interface HydratedContact {
  id: string;
  name: string;
  email?: string;
  phoneNumber?: string;
  blocked: boolean;
  identifier?: string;
  customAttributes: Record<string, any>;
  additionalAttributes: Record<string, any>;
  lastActivityAt?: Date;
  createdAt?: Date;
  labels?: LabelDto[];
}

/**
 * Map a CRM `ContactDto` (snake_case wire format) to the evo-flow
 * `HydratedContact` shape (camelCase). Returns null when input is null.
 */
export function mapContactDto(dto: ContactDto | null): HydratedContact | null {
  if (!dto) return null;
  return {
    id: dto.id,
    name: dto.name ?? '',
    email: dto.email ?? undefined,
    phoneNumber: dto.phone_number ?? undefined,
    blocked: dto.blocked ?? false,
    identifier: dto.identifier ?? undefined,
    customAttributes: (dto.custom_attributes as Record<string, any>) ?? {},
    additionalAttributes:
      (dto.additional_attributes as Record<string, any>) ?? {},
    lastActivityAt: dto.last_activity_at
      ? new Date(dto.last_activity_at * 1000)
      : undefined,
    createdAt: dto.created_at ? new Date(dto.created_at * 1000) : undefined,
    labels: dto.labels,
  };
}
