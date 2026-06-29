import { ContactsClientService } from './contacts-client.service';
import type { CrmClientService } from './crm-client.service';

describe('ContactsClientService', () => {
  let crm: jest.Mocked<CrmClientService>;
  let service: ContactsClientService;

  beforeEach(() => {
    crm = {
      get: jest.fn(),
      post: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
    } as unknown as jest.Mocked<CrmClientService>;
    service = new ContactsClientService(crm);
  });

  describe('findById', () => {
    it('calls GET /api/v1/contacts/:id and returns the contact', async () => {
      crm.get.mockResolvedValueOnce({ id: 'abc', name: 'Test' });

      const result = await service.findById('abc');

      expect(crm.get).toHaveBeenCalledWith('/api/v1/contacts/abc', undefined);
      expect(result).toEqual({ id: 'abc', name: 'Test' });
    });

    it('unwraps { data: ... } envelope when CRM returns wrapped response', async () => {
      crm.get.mockResolvedValueOnce({ data: { id: 'abc', name: 'Wrapped' } });

      const result = await service.findById('abc');

      expect(result).toEqual({ id: 'abc', name: 'Wrapped' });
    });

    it('returns null when crm.get returns null (404)', async () => {
      crm.get.mockResolvedValueOnce(null);

      const result = await service.findById('missing');
      expect(result).toBeNull();
    });
  });

  describe('addLabel', () => {
    it('POSTs to /api/v1/contacts/:id/labels with body { labels: [<label>] }', async () => {
      crm.post.mockResolvedValueOnce({});

      await service.addLabel('abc', 'vip');

      expect(crm.post).toHaveBeenCalledWith(
        '/api/v1/contacts/abc/labels',
        { labels: ['vip'] },
        undefined,
      );
    });
  });

  describe('removeLabel', () => {
    // GET /contacts/:id serializes labels as { name, color } (no id/title).
    it('GETs (no-cache) + PATCHes with the surviving label names', async () => {
      crm.get.mockResolvedValueOnce({
        id: 'abc',
        labels: [
          { name: 'vip', color: '#111' },
          { name: 'lead', color: '#222' },
        ],
      });
      crm.patch.mockResolvedValueOnce({});

      await service.removeLabel('abc', 'vip');

      expect(crm.get).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        expect.objectContaining({ noCache: true }),
      );
      expect(crm.patch).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        { labels: ['lead'] },
        undefined,
      );
    });

    // EVO-1928 regression: removing one label must NOT wipe the siblings.
    // With the old id/title matching, the survivors mapped to `undefined` →
    // PATCH { labels: [null, null] }, clearing the entire set while the node
    // still reported success.
    it('does not wipe the other labels (real { name } serialization)', async () => {
      crm.get.mockResolvedValueOnce({
        id: 'abc',
        labels: [
          { name: 'vip', color: '#111' },
          { name: 'lead', color: '#222' },
          { name: 'customer', color: '#333' },
        ],
      });
      crm.patch.mockResolvedValueOnce({});

      await service.removeLabel('abc', 'lead');

      expect(crm.patch).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        { labels: ['vip', 'customer'] },
        undefined,
      );
    });

    // Back-compat: any endpoint/caller still carrying { id, title } keeps
    // matching by id or title and maps to the title.
    it('matches a legacy { id, title } label by id or title', async () => {
      crm.get.mockResolvedValueOnce({
        id: 'abc',
        labels: [
          { id: 'l1', title: 'vip' },
          { id: 'l2', title: 'lead' },
        ],
      });
      crm.patch.mockResolvedValueOnce({});

      await service.removeLabel('abc', 'l1');

      expect(crm.patch).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        { labels: ['lead'] },
        undefined,
      );
    });
  });

  describe('listAllIds', () => {
    it('paginates until short page is returned', async () => {
      crm.get
        .mockResolvedValueOnce({
          data: { payload: [{ id: 'a', blocked: false }, { id: 'b', blocked: true }] },
        })
        .mockResolvedValueOnce({
          data: { payload: [{ id: 'c', blocked: false }] }, // short page -> stop
        });

      const result = await service.listAllIds({ pageSize: 2 });

      expect(result).toEqual([
        { id: 'a', blocked: false },
        { id: 'b', blocked: true },
        { id: 'c', blocked: false },
      ]);
      expect(crm.get).toHaveBeenCalledTimes(2);
    });

    it('returns empty array when first page empty', async () => {
      crm.get.mockResolvedValueOnce({ data: { payload: [] } });
      const result = await service.listAllIds({ pageSize: 2 });
      expect(result).toEqual([]);
    });

    it('accepts plain array payload', async () => {
      crm.get
        .mockResolvedValueOnce([{ id: 'a', blocked: false }])
        .mockResolvedValueOnce([]);
      const result = await service.listAllIds({ pageSize: 2 });
      expect(result).toEqual([{ id: 'a', blocked: false }]);
    });
  });

  describe('findByIds', () => {
    it('returns empty array for empty input', async () => {
      const result = await service.findByIds([]);
      expect(result).toEqual([]);
      expect(crm.get).not.toHaveBeenCalled();
    });

    it('returns DTOs for all ids when all hit', async () => {
      crm.get
        .mockResolvedValueOnce({ id: 'a', name: 'A' })
        .mockResolvedValueOnce({ id: 'b', name: 'B' });

      const result = await service.findByIds(['a', 'b']);

      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['a', 'b']);
    });

    it('filters out null entries (404s)', async () => {
      crm.get
        .mockResolvedValueOnce({ id: 'a', name: 'A' })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'c', name: 'C' });

      const result = await service.findByIds(['a', 'missing', 'c']);

      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['a', 'c']);
    });

    it('deduplicates ids before fetching', async () => {
      crm.get.mockResolvedValue({ id: 'a', name: 'A' });

      const result = await service.findByIds(['a', 'a', 'a']);

      expect(crm.get).toHaveBeenCalledTimes(1);
      expect(result).toHaveLength(1);
    });

    it('swallows per-id errors and returns surviving DTOs', async () => {
      crm.get
        .mockResolvedValueOnce({ id: 'a', name: 'A' })
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce({ id: 'c', name: 'C' });

      const result = await service.findByIds(['a', 'b', 'c']);

      expect(result).toHaveLength(2);
      expect(result.map((c) => c.id).sort()).toEqual(['a', 'c']);
    });

    it('chunks calls with concurrency of 10', async () => {
      const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
      crm.get.mockImplementation(async (path: string) => ({
        id: path.split('/').pop(),
        name: 'X',
      }));

      const result = await service.findByIds(ids);

      expect(result).toHaveLength(25);
      expect(crm.get).toHaveBeenCalledTimes(25);
    });
  });

  describe('update', () => {
    it('PATCHes /api/v1/contacts/:id with the given fields verbatim', async () => {
      crm.patch.mockResolvedValueOnce({});

      await service.update('abc', { name: 'Renamed', phone_number: '+5511' });

      expect(crm.patch).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        { name: 'Renamed', phone_number: '+5511' },
        undefined,
      );
    });
  });

  describe('updateCustomAttribute', () => {
    it('PATCHes /api/v1/contacts/:id with { custom_attributes: { [key]: value } }', async () => {
      crm.patch.mockResolvedValueOnce({});

      await service.updateCustomAttribute(
        'abc',
        'last_purchase_at',
        '2026-05-14',
      );

      expect(crm.patch).toHaveBeenCalledWith(
        '/api/v1/contacts/abc',
        { custom_attributes: { last_purchase_at: '2026-05-14' } },
        undefined,
      );
    });
  });
});
