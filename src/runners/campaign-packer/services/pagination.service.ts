import { Injectable } from '@nestjs/common';

export interface Page {
  page: number;
  totalPages: number;
  contactIds: string[];
}

/**
 * Pure pagination helper for the campaign-packer (story 4.2 / EVO-1216).
 * Splits a resolved audience into fixed-size batches. `page` is 1-based to
 * satisfy the `campaigns.send` contract (page ≥ 1, page ≤ totalPages).
 */
@Injectable()
export class PaginationService {
  split(contactIds: string[], batchSize: number): Page[] {
    if (contactIds.length === 0) {
      return [];
    }

    const size = Math.max(1, Math.trunc(batchSize));
    const totalPages = Math.ceil(contactIds.length / size);
    const pages: Page[] = [];
    for (let page = 1; page <= totalPages; page += 1) {
      const start = (page - 1) * size;
      pages.push({
        page,
        totalPages,
        contactIds: contactIds.slice(start, start + size),
      });
    }
    return pages;
  }
}
