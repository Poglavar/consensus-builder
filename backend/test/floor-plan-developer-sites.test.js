import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importDeveloperSites } from '../floor-plans/developer-sites.js';
import { runCli } from '../scripts/floor-plan-archive.mjs';

const record = {
    id: 'dev-1', name: 'Example Development', legal_name: 'Example Development d.o.o.',
    website: 'https://developer.test/', website_evidence_url: 'https://www.developer.test/about/',
    verification_basis: 'The developer website identifies the company and its residential development role.',
    discovery_evidence_urls: ['https://registry.test/developers/example'],
    seed_project_urls: ['https://developer.test/projects/example/'],
};
function db({ siteEvidence = null, sourceKind = null } = {}) {
    return { query: vi.fn(async sql => {
        if (sql.startsWith('SELECT url,evidence,verification_status,name,agency_id')) return { rows: siteEvidence ? [{ url: 'https://www.developer.test/', evidence: siteEvidence, verification_status: 'verified_registry_company', name: 'Existing name', agency_id: null }] : [] };
        if (sql.startsWith('SELECT source_kind FROM floor_plan.target')) return { rows: sourceKind ? [{ source_kind: sourceKind }] : [] };
        if (sql.startsWith('INSERT INTO floor_plan.target')) return { rows: [{ inserted: true }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    }) };
}

describe('developer source import', () => {
    it('records distinct developer role evidence and queues only verified site seeds', async () => {
        const client = db();
        expect(await importDeveloperSites(client, { source: 'Zagreb developer association list', observedAt: '2026-10-14', scope_complete: false, records: [record] }))
            .toEqual({ developers: 1, sites: 1, queued: 3, scopeComplete: false });
        const siteWrite = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO floor_plan.site'));
        const evidence = JSON.parse(siteWrite[1][3]);
        expect(evidence).toMatchObject({ sourceKind: 'developer', developerSource: {
            developerId: record.id, roleStatus: 'verified-own-site', authority: 'Zagreb developer association list',
            roleEvidenceUrl: record.website_evidence_url, discoveryEvidenceUrls: record.discovery_evidence_urls,
            sourceObservedAt: '2026-10-14', scopeComplete: false,
        } });
        const queued = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO floor_plan.target'));
        expect(queued.map(([, args]) => [args[0], args[2], args[6]])).toEqual([
            ['https://developer.test/', 'home', 'developer'],
            ['https://developer.test/sitemap.xml', 'sitemap', 'developer'],
            ['https://developer.test/projects/example/', 'page', 'developer'],
        ]);
    });

    it('preserves existing architecture source type and site evidence on an overlapping domain', async () => {
        const prior = { sourceKind: 'architecture', studioId: 'studio-1', authority: 'HKA' };
        const client = db({ siteEvidence: prior, sourceKind: 'architecture' });
        await importDeveloperSites(client, { records: [record] });
        const siteWrite = client.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO floor_plan.site'));
        expect(JSON.parse(siteWrite[1][3])).toMatchObject({ sourceKind: 'architecture', developerSource: { developerId: 'dev-1' } });
        expect(siteWrite[0]).toContain("evidence=floor_plan.site.evidence || jsonb_build_object('developerSource'");
        const queued = client.query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO floor_plan.target'));
        expect(queued.every(([, args]) => args[6] === 'architecture')).toBe(true);
        expect(siteWrite[1][4]).toBe('verified_registry_company');
    });

    it.each([
        { website: 'https://user:pass@developer.test/' },
        { website_evidence_url: 'https://other.test/about/' },
        { seed_project_urls: ['https://elsewhere.test/project/'] },
        { discovery_evidence_urls: [] },
    ])('validates the whole developer document before writing: %j', async change => {
        const client = db();
        await expect(importDeveloperSites(client, { records: [{ ...record, ...change }] })).rejects.toThrow(/Developer needs/);
        expect(client.query).not.toHaveBeenCalled();
    });

    it('rejects duplicate identities and domains and keeps roster scope partial', async () => {
        const client = db();
        await expect(importDeveloperSites(client, { scope_complete: true, records: [record, { ...record, id: 'dev-2' }] }))
            .rejects.toThrow(/must be unique/);
        expect(client.query).not.toHaveBeenCalled();
        const sql = await readFile(new URL('../db/floor-plan-archive.sql', import.meta.url), 'utf8');
        expect(sql).toContain("CHECK(source_kind IN ('agency','architecture','developer'))");
    });

    it('wires the developer-sites CLI command to the supplied evidence file', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'developer-sites-cli-'));
        try {
            const file = join(dir, 'developers.json');
            await writeFile(file, JSON.stringify({ records: [record] }));
            const client = db();
            client.connect = vi.fn(); client.end = vi.fn();
            client.query.mockImplementation(async sql => {
                if (sql.startsWith('SELECT DISTINCT street_name')) return { rows: [] };
                if (sql.startsWith('SELECT url,evidence,verification_status,name,agency_id')) return { rows: [] };
                if (sql.startsWith('SELECT source_kind FROM floor_plan.target')) return { rows: [] };
                if (sql.startsWith('INSERT INTO floor_plan.target')) return { rows: [{ inserted: true }], rowCount: 1 };
                return { rows: [], rowCount: 1 };
            });
            const output = vi.fn();
            expect(await runCli(['developer-sites', '--file', file], { clientFactory: () => client, output })).toBe(0);
            expect(output).toHaveBeenCalledWith(expect.objectContaining({ developers: 1, queued: 3 }));
            expect(client.end).toHaveBeenCalledOnce();
        } finally { await rm(dir, { recursive: true, force: true }); }
    });
});
