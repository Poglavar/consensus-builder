// Purpose: verify official HGK registry parsing, pagination, and Zagreb filtering.
import { describe, expect, it, vi } from 'vitest';
import { fetchHgkRegistry, parseRegistryPage, selectZagrebRecords } from '../floor-plans/registry.js';

const page = (total, rows) => ({ data: { brojZapisa: total, posrednici: rows } });
const row = (id, address = 'Ilica 1, 10000 ZAGREB, HRVATSKA') => ({ id, regBroj: `${id}/2024`, mb: '123', oib: '1', naziv: ` Agency ${id}`, adresaSjedista: address });

describe('HGK registry', () => {
    it('parses official fields and explicit Zagreb settlements', () => {
        const parsed = parseRegistryPage(page(2, [row(1), row(2, 'Ulica 1, SESVETE, HRVATSKA')]), 'https://example.test/1');
        expect(parsed.records[0]).toMatchObject({ registry_id: '1', legal_name: 'Agency 1', settlement: 'ZAGREB', scope: 'Croatia' });
        expect(selectZagrebRecords([...parsed.records, ...parseRegistryPage(page(1, [row(3, 'Trg 1, 10290 ZAPREŠIĆ, HRVATSKA')]), 'x').records])).toHaveLength(2);
    });

    it('fetches every page, archives each raw response, and refuses partial results', async () => {
        const fetcher = vi.fn(async url => ({ status: 200, body: Buffer.from(JSON.stringify(url.includes('page-number=1') ? page(101, Array.from({ length: 100 }, (_, i) => row(i + 1))) : page(101, [row(101)]))), blockedReason: null }));
        const onPage = vi.fn();
        const result = await fetchHgkRegistry({ fetcher, onPage });
        expect(result.total_registry_rows).toBe(101); expect(result.records).toHaveLength(101); expect(onPage).toHaveBeenCalledTimes(2);
        await expect(fetchHgkRegistry({ maxPages: 1, fetcher: async () => ({ status: 200, body: Buffer.from(JSON.stringify(page(101, [row(1)]))) }) })).rejects.toThrow(/partial/);
    });

    it('rejects duplicate IDs on the first page',async()=>{await expect(fetchHgkRegistry({fetcher:async()=>({status:200,body:Buffer.from(JSON.stringify(page(2,[row(1),row(1)])))})})).rejects.toThrow(/Duplicate/);});
    it('includes Lučko independently of accents',()=>{const rows=parseRegistryPage(page(1,[row(7,'Ulica 1, 10250 LUCKO, HRVATSKA')]),'x').records;expect(selectZagrebRecords(rows)).toHaveLength(1);});
    it('does not confuse Strmec Samoborski with City Strmec',()=>{const rows=parseRegistryPage(page(3,[row(8,'Road 1, 10434 STRMEC, HRVATSKA'),row(9,'Road 1, 10340 STRMEC, HRVATSKA'),row(10,'Tratine 1, 10020 STRMEC, HRVATSKA')]),'x').records;expect(selectZagrebRecords(rows).map(r=>r.registry_id)).toEqual(['10']);});
    it('rejects empty or malformed official responses', async () => {
        await expect(fetchHgkRegistry({ fetcher: async () => ({ status: 403, body: null, blockedReason: 'http-403' }) })).rejects.toThrow(/unavailable/);
        expect(() => parseRegistryPage({ data: { brojZapisa: 1, posrednici: [{}] } }, 'x')).toThrow(/row/);
    });
});
