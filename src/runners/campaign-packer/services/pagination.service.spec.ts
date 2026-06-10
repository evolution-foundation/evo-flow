import { PaginationService } from './pagination.service';

describe('PaginationService', () => {
  const service = new PaginationService();

  const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `contact-${i + 1}`);

  it('splits 2500 ids into [1000, 1000, 500] pages with totalPages 3 (AC1/AC3)', () => {
    const pages = service.split(ids(2500), 1000);

    expect(pages.map((p) => p.contactIds.length)).toEqual([1000, 1000, 500]);
    expect(pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(pages.every((p) => p.totalPages === 3)).toBe(true);
  });

  it('produces exact-multiple pages without a trailing remainder', () => {
    const pages = service.split(ids(2000), 1000);

    expect(pages).toHaveLength(2);
    expect(pages.map((p) => p.contactIds.length)).toEqual([1000, 1000]);
  });

  it('returns a single page when the audience is smaller than the batch', () => {
    const pages = service.split(ids(500), 1000);

    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ page: 1, totalPages: 1 });
    expect(pages[0].contactIds).toHaveLength(500);
  });

  it('returns no pages for an empty audience', () => {
    expect(service.split([], 1000)).toEqual([]);
  });

  it('preserves order and partitions the audience without overlap', () => {
    const all = ids(2500);

    const flattened = service.split(all, 1000).flatMap((p) => p.contactIds);

    expect(flattened).toEqual(all);
  });
});
