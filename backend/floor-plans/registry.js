// Fetch and validate the official Croatian property-broker registry pages.
import { fetchPublic } from './fetch-public.js';
import settlementData from '../../data/floor-plan-agencies/city-settlements.json' with { type: 'json' };

const endpoint = page => `https://digitalnakomora.hr/HGKPosredniciAPI/api/posrednici?page-number=${page}&page-size=100`;
const fold = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
const zagrebSettlements = new Set(settlementData.settlements.map(fold));

export function parseRegistryPage(raw, sourceEndpoint) {
    const root = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const data = root?.data;
    if (!data || !Number.isInteger(data.brojZapisa) || !Array.isArray(data.posrednici)) throw new Error('Invalid HGK registry response');
    const records = data.posrednici.map(row => {
        if (!row || row.id == null || !row.regBroj || !row.naziv || !row.adresaSjedista) throw new Error('Invalid HGK registry row');
        const address = String(row.adresaSjedista).trim();
        const parts = address.split(',').map(part => part.trim()).filter(Boolean);
        if (/^HRVATSKA$/i.test(parts.at(-1) || '')) parts.pop();
        const settlement = (parts.at(-1) || '').replace(/^\d{5}\s+/, '') || null;
        return { registry_id: String(row.id), registration_number: row.regBroj, mb: row.mb || null, oib: row.oib || null, legal_name: String(row.naziv).trim(), registered_address: address, source_endpoint: sourceEndpoint, settlement, scope: 'Croatia', ...(row.web || row.website ? { website: row.web || row.website } : {}) };
    });
    return { total: data.brojZapisa, records };
}

export function selectZagrebRecords(records) {
    return records.filter(record => {
        const name=fold(record.settlement);
        if(!zagrebSettlements.has(name)) return false;
        const allowedPostcodes=settlementData.ambiguous_settlement_postcodes[name];
        const postcode=record.registered_address?.match(/,\s*(\d{5})\s+[^,]+(?:,\s*HRVATSKA)?$/i)?.[1];
        return !allowedPostcodes || allowedPostcodes.includes(postcode);
    });
}

export async function fetchHgkRegistry({ fetcher = fetchPublic, onPage = async () => {}, maxPages } = {}) {
    const firstUrl = endpoint(1);
    const first = await fetcher(firstUrl, { respectRobots: true });
    if (first.blockedReason || !first.body || first.status < 200 || first.status >= 300) throw new Error(`HGK registry unavailable: ${first.blockedReason || `HTTP ${first.status}`}`);
    const parsed = parseRegistryPage(first.body.toString(), firstUrl);
    const pages = Math.ceil(parsed.total / 100);
    if (maxPages != null && maxPages < pages) throw new Error('Refusing partial HGK registry fetch');
    await onPage({ page: 1, url: firstUrl, response: first });
    const records = [...parsed.records]; const ids = new Set();
    for (const record of records) { if (ids.has(record.registry_id)) throw new Error(`Duplicate HGK registry ID ${record.registry_id}`); ids.add(record.registry_id); }
    for (let page = 2; page <= pages; page++) {
        const url = endpoint(page); const response = await fetcher(url, { respectRobots: true });
        if (response.blockedReason || !response.body || response.status < 200 || response.status >= 300) throw new Error(`HGK registry unavailable on page ${page}`);
        const result = parseRegistryPage(response.body.toString(), url);
        if (result.total !== parsed.total) throw new Error(`HGK registry total changed on page ${page}`);
        for (const record of result.records) { if (ids.has(record.registry_id)) throw new Error(`Duplicate HGK registry ID ${record.registry_id}`); ids.add(record.registry_id); }
        await onPage({ page, url, response }); records.push(...result.records);
    }
    if (records.length !== parsed.total) throw new Error(`HGK registry incomplete: expected ${parsed.total}, got ${records.length}`);
    return { source: 'https://digitalnakomora.hr/HGKPosredniciAPI/api/posrednici', retrievedAt: new Date().toISOString(), total_registry_rows: parsed.total, records };
}
