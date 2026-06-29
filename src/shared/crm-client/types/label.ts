/**
 * Label DTO across evo-ai-crm-community REST surfaces.
 *
 * IMPORTANT: the serialized shape varies by endpoint.
 * - `GET /contacts/:id` (CRM `ContactSerializer`) serializes each label as
 *   `{ name, color }` — there is NO `id`/`title`. This is what `findById`
 *   returns and what `removeLabel` reads, so `name` is the field to match and
 *   map on there.
 * - The dedicated `/labels` endpoints expose `{ id, title, ... }`.
 *
 * Every identity field is therefore optional and consumers must tolerate
 * either shape: match by `name` first, fall back to `title`/`id`.
 */
export interface LabelDto {
  name?: string;
  title?: string;
  id?: string;
  color?: string;
}
