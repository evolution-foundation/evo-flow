import { Injectable } from '@nestjs/common';
import { CrmClientService } from './crm-client.service';
import type { ContactDto } from './types/contact';
import type { LabelDto } from './types/label';
import type { RequestOptions } from './types/responses';

/**
 * ContactsClientService — domain methods for contact resources in
 * evo-ai-crm-community.
 *
 * Endpoints (see method-endpoint-mapping.md §1-4):
 *  - findById:              `GET    /api/v1/contacts/{id}`
 *  - addLabel:              `POST   /api/v1/contacts/{id}/labels`         body: { labels: [<title>] }
 *  - removeLabel:           read-modify-write via GET+PATCH (CRM has no DELETE /labels/{title})
 *  - updateCustomAttribute: `PATCH  /api/v1/contacts/{id}`                body: { custom_attributes: { [key]: value } }
 */
@Injectable()
export class ContactsClientService {
  constructor(private readonly crm: CrmClientService) {}

  async findById(
    id: string,
    opts?: RequestOptions,
  ): Promise<ContactDto | null> {
    const data = await this.crm.get<ContactDto | { data: ContactDto }>(
      `/api/v1/contacts/${id}`,
      opts,
    );
    if (data === null) return null;
    // CRM Rails sometimes wraps responses in `{ data: ... }`.
    return ((data as any)?.data ?? data) as ContactDto;
  }

  /**
   * Fetch multiple contacts by id. CRM Rails currently has no bulk endpoint
   * (`GET /api/v1/contacts?ids[]=...`) so this fans out to N parallel
   * `findById` calls with a concurrency pool of 10. CrmClientService already
   * applies LRU caching at the request level, so repeated ids inside the same
   * 30s window are deduplicated transparently.
   *
   * Result preserves no particular order. Null entries (404s) are filtered
   * out — caller gets only the contacts that exist.
   *
   * When CRM adds a bulk endpoint, swap this for a single request.
   */
  async findByIds(
    ids: string[],
    opts?: RequestOptions,
  ): Promise<ContactDto[]> {
    if (!ids || ids.length === 0) return [];

    // De-duplicate to avoid wasted HTTP calls (the CrmClientService LRU
    // already dedupes within TTL, but skip the request loop entirely here).
    const uniqueIds = Array.from(new Set(ids));

    const concurrency = 10;
    const results: ContactDto[] = [];

    for (let i = 0; i < uniqueIds.length; i += concurrency) {
      const chunk = uniqueIds.slice(i, i + concurrency);
      const settled = await Promise.all(
        chunk.map((id) => this.findById(id, opts).catch(() => null)),
      );
      for (const dto of settled) {
        if (dto !== null) results.push(dto);
      }
    }

    return results;
  }

  /**
   * Paginate `GET /api/v1/contacts` and return every contact id (with
   * basic blocked-flag info so callers can filter pre-fetch).
   *
   * Used by `sendToAll` campaign audience composition: prior to this Q3
   * cleanup, evo-flow ran `SELECT id FROM contacts WHERE blocked = false`
   * locally. Post-refactor CRM owns the data and we fan out via this
   * paginator. The page size is large (500) to keep the round trips few.
   *
   * Returns minimal records (id + blocked) to avoid materializing every
   * full ContactDto when the caller only needs ids. Pagination stops when
   * a page returns fewer than pageSize records OR an empty page.
   */
  async listAllIds(
    opts?: RequestOptions & { pageSize?: number; maxPages?: number },
  ): Promise<Array<{ id: string; blocked: boolean }>> {
    const pageSize = opts?.pageSize ?? 500;
    const maxPages = opts?.maxPages ?? 1000; // safety bound: 500k contacts
    const out: Array<{ id: string; blocked: boolean }> = [];

    for (let page = 1; page <= maxPages; page++) {
      const payload = await this.crm.get<any>(
        `/api/v1/contacts?page=${page}&pageSize=${pageSize}`,
        opts,
      );

      // CRM Rails wraps in { data: [...] } or { data: { payload: [...] } }.
      // Accept multiple shapes defensively.
      const raw = payload == null ? null : payload;
      const list: any[] =
        (raw?.data?.payload as any[]) ??
        (raw?.data as any[]) ??
        (raw?.payload as any[]) ??
        (Array.isArray(raw) ? raw : []);

      if (!list || list.length === 0) break;

      for (const c of list) {
        if (c && typeof c.id === 'string') {
          out.push({ id: c.id, blocked: c.blocked === true });
        } else if (c && typeof c.id === 'number') {
          out.push({ id: String(c.id), blocked: c.blocked === true });
        }
      }

      if (list.length < pageSize) break;
    }

    return out;
  }

  async addLabel(
    id: string,
    label: string,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.crm.post<unknown>(
      `/api/v1/contacts/${id}/labels`,
      { labels: [label] },
      opts,
    );
  }

  /**
   * Remove a label from a contact via read-modify-write.
   *
   * The CRM Rails endpoint replaces the full label list on PATCH, so we
   * read current labels (no-cache to avoid stale data), filter out the
   * target, then PATCH with the surviving label names.
   *
   * EVO-1928: `GET /contacts/:id` serializes labels as `{ name, color }` —
   * NO `id`/`title`. The previous filter/map keyed on `lbl.id`/`lbl.title`
   * (always `undefined` on the real shape) so the target was never removed
   * AND every survivor mapped to `undefined` → `PATCH { labels: [null, …] }`,
   * which wiped the contact's entire label set (the node still reported
   * success). Match/map by `name` (the real field), tolerating legacy
   * title/id, and drop blanks so a `[null]` can never reach the CRM.
   */
  async removeLabel(
    id: string,
    label: string,
    opts?: RequestOptions,
  ): Promise<void> {
    const current = await this.findById(id, { ...opts, noCache: true });
    if (!current) {
      // Match the spec: 404 in write semantics. Reuse the crm.post path with
      // a phantom PATCH so the caller sees NotFoundException consistently.
      // Simpler: just throw via PATCH which returns 404.
      await this.crm.patch<unknown>(
        `/api/v1/contacts/${id}`,
        { labels: [] },
        opts,
      );
      return;
    }

    const remaining = (current.labels ?? [])
      .filter(
        (lbl: LabelDto) =>
          lbl.name !== label && lbl.title !== label && lbl.id !== label,
      )
      .map((lbl: LabelDto) => lbl.name ?? lbl.title)
      .filter((name): name is string => Boolean(name && name.length > 0));

    await this.crm.patch<unknown>(
      `/api/v1/contacts/${id}`,
      { labels: remaining },
      opts,
    );
  }

  /**
   * Partial update of a contact. Accepts any subset of writable CRM fields
   * (e.g. `name`, `email`, `phone_number`, `custom_attributes`, ...). The
   * body is passed through unchanged so callers must speak the CRM Rails
   * wire format (snake_case).
   *
   * Used by temporal nodes that mutate contact fields based on flow input.
   */
  async update(
    id: string,
    fields: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.crm.patch<unknown>(
      `/api/v1/contacts/${id}`,
      fields,
      opts,
    );
  }

  /**
   * ⚠️ Single-key custom attribute write. The CRM Rails `PATCH /contacts/:id`
   * endpoint **REPLACES** the whole `custom_attributes` JSONB column (it does
   * NOT deep-merge, unlike `additional_attributes`), so sending one key here
   * wipes every other custom attribute on the contact. Prefer
   * `setCustomAttributes` with a merged map. Kept for callers that genuinely
   * intend a full replace.
   */
  async updateCustomAttribute(
    id: string,
    key: string,
    value: unknown,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.crm.patch<unknown>(
      `/api/v1/contacts/${id}`,
      { custom_attributes: { [key]: value } },
      opts,
    );
  }

  /**
   * Write the full `custom_attributes` map for a contact. Because the CRM
   * PATCH replaces the column wholesale, callers must pass the complete map
   * they want persisted (i.e. read-modify-write: spread the contact's existing
   * `customAttributes` and override the keys they're changing). See EVO-1850.
   */
  async setCustomAttributes(
    id: string,
    attributes: Record<string, unknown>,
    opts?: RequestOptions,
  ): Promise<void> {
    await this.crm.patch<unknown>(
      `/api/v1/contacts/${id}`,
      { custom_attributes: attributes },
      opts,
    );
  }
}
