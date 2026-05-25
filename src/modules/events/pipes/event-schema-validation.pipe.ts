import {
  BadRequestException,
  Injectable,
  PipeTransform,
  type ArgumentMetadata,
} from '@nestjs/common';
import { getEvent } from '../manifest';
import type { EventSchema, FieldSpec, FieldType } from '../manifest';

interface InboundPayload {
  event?: unknown;
  eventName?: unknown;
  properties?: unknown;
  traits?: unknown;
  [key: string]: unknown;
}

@Injectable()
export class EventSchemaValidationPipe implements PipeTransform<InboundPayload, InboundPayload> {
  transform(value: InboundPayload, metadata: ArgumentMetadata): InboundPayload {
    if (metadata.type !== 'body' || !isPlainObject(value)) {
      return value;
    }

    const eventName = pickEventName(value);
    if (!eventName) {
      return value;
    }

    const entry = getEvent(eventName);
    if (!entry) {
      return value;
    }

    const payload = pickPayload(value);
    this.validateAgainstSchema(eventName, entry.schema, payload);
    return value;
  }

  private validateAgainstSchema(
    eventName: string,
    schema: EventSchema,
    payload: Record<string, unknown>,
  ): void {
    for (const [field, spec] of Object.entries(schema.required)) {
      if (payload[field] === undefined || payload[field] === null) {
        throw new BadRequestException({
          error: 'MissingRequiredField',
          field,
          eventName,
        });
      }
      this.assertFieldType(eventName, field, spec, payload[field]);
    }

    for (const [field, spec] of Object.entries(schema.optional)) {
      if (payload[field] !== undefined && payload[field] !== null) {
        this.assertFieldType(eventName, field, spec, payload[field]);
      }
    }
  }

  private assertFieldType(
    eventName: string,
    field: string,
    spec: FieldSpec,
    raw: unknown,
  ): void {
    if (!matchesType(spec.type, raw)) {
      throw new BadRequestException({
        error: 'InvalidFieldType',
        field,
        eventName,
        expected: spec.type,
        got: actualType(raw),
      });
    }
  }
}

function pickEventName(value: InboundPayload): string | undefined {
  if (typeof value.event === 'string') return value.event;
  if (typeof value.eventName === 'string') return value.eventName;
  return undefined;
}

function pickPayload(value: InboundPayload): Record<string, unknown> {
  if (isPlainObject(value.properties)) return value.properties as Record<string, unknown>;
  if (isPlainObject(value.traits)) return value.traits as Record<string, unknown>;
  return {};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function matchesType(type: FieldType, raw: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof raw === 'string';
    case 'number':
      return typeof raw === 'number' && Number.isFinite(raw);
    case 'boolean':
      return typeof raw === 'boolean';
    case 'object':
      return isPlainObject(raw);
    case 'uuid':
      return typeof raw === 'string' || typeof raw === 'number';
    case 'date':
      if (raw instanceof Date) return !Number.isNaN(raw.getTime());
      if (typeof raw === 'string') return !Number.isNaN(Date.parse(raw));
      return false;
    default:
      return false;
  }
}

function actualType(raw: unknown): string {
  if (raw === null) return 'null';
  if (Array.isArray(raw)) return 'array';
  return typeof raw;
}
