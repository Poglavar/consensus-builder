import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
import { proposalDocument, planDocument, canonicalPublicationBase } from '../semantics/published-records.js';
import { vocabularyDocument, NAMESPACE, CONTEXT, designGoals, decisionKinds } from '../semantics/vocabulary.js';
import { LIFECYCLE_STATUSES } from '../proposals/lifecycle.js';
import { vocabularyArtifacts } from '../scripts/build-vocabulary.mjs';
import { memberHash } from '../plans/plan-hash.js';

const baseUrl = 'https://publication.example/api';
const site = { type: 'Polygon', coordinates: [[[12, 45], [12.01, 45], [12.01, 45.01], [12, 45]]] };
const proposal = (patch = {}) => ({ id: 7, proposalId: 'draft-7', kind: 'community-vote', goal: 'park', lifecycleStatus: 'Active', site, cadastreParcelIds: ['source:7'], ...patch });
const nodeWithType = (nodes, type) => nodes.find(node => node['@type']?.includes(type));
const values = (node, property) => (node[property] || []).map(value => value['@value']);
const ids = (node, property) => (node[property] || []).map(value => value['@id']);

describe('published JSON-LD consumer questions', () => {
    it('distinguishes a publication row, authored ID, design goal, decision kind and site', async () => {
        const nodes = await jsonld.flatten(proposalDocument(proposal(), { baseUrl }));
        const record = nodeWithType(nodes, `${NAMESPACE}Proposal`);
        expect(record['@id']).toBe(`${baseUrl}/proposals/7#proposal`);
        expect(values(record, `${NAMESPACE}proposalRowId`)).toEqual(['7']);
        expect(values(record, `${NAMESPACE}authoredProposalId`)).toEqual(['draft-7']);
        expect(ids(record, `${NAMESPACE}designGoal`)).toEqual([`${NAMESPACE}goal-park`]);
        expect(ids(record, `${NAMESPACE}decisionKind`)).toEqual([`${NAMESPACE}kind-community-vote`]);
        const geometry = nodeWithType(nodes, `${CONTEXT.geo}Geometry`);
        const serialization = geometry[`${CONTEXT.geo}asGeoJSON`][0];
        expect(serialization['@type']).toBe(`${CONTEXT.geo}geoJSONLiteral`);
        expect(JSON.parse(serialization['@value'])).toEqual(site);
        const cadastral = nodeWithType(nodes, `${NAMESPACE}CadastreReference`);
        expect(values(cadastral, `${NAMESPACE}declaredIdentifier`)).toEqual(['source:7']);
        expect(cadastral['@id']).not.toBe(nodeWithType(nodes, `${NAMESPACE}ProposalSite`)['@id']);
        expect(nodes.some(node => node['@type']?.includes('https://schema.org/Building'))).toBe(false);
    });

    it('scopes identical local IDs to their publication stores without merging cadastral references', () => {
        const a = proposalDocument(proposal(), { baseUrl });
        const b = proposalDocument(proposal(), { baseUrl: 'https://second.example/api' });
        const c = proposalDocument(proposal({ id: 8 }), { baseUrl });
        expect(a['@id']).not.toBe(b['@id']);
        expect(a['cb:cadastreReference'][0]['@id']).not.toBe(c['cb:cadastreReference'][0]['@id']);
    });

    it('does not turn arbitrary authored content, unknown goals or local claims into RDF assertions', async () => {
        const doc = proposalDocument(proposal({ goal: 'custom-shape', lifecycleStatus: 'nonsense',
            applied: true, executedAt: '2026-01-01', ownerAcceptances: ['signed-by-nobody'], author: 'Declared studio',
            '@context': { evil: 'https://injected.example/' }, 'evil:owner': 'someone',
            chainMirror: { lifecycleStatus: 'Executed' }, onchainData: { proposalId: 'wrong' }
        }), { baseUrl });
        const rdf = await jsonld.toRDF(doc, { format: 'application/n-quads' });
        expect(rdf).toContain(`${NAMESPACE}lifecycle-Unknown`);
        expect(rdf).toContain('custom-shape');
        expect(rdf).not.toMatch(/injected|signed-by-nobody|executedAt|applied|Person|Organization|wrong/);
        expect(doc['cb:designGoal']).toBeUndefined();
        expect(doc['cb:declaredChainReference']).toBeUndefined();
        expect(doc['cb:authorLabel']).toBe('Declared studio');
    });

    it('keeps explicit zero-valued offers and budget currencies distinct from atomic chain balances', async () => {
        const nodes = await jsonld.flatten(proposalDocument(proposal({ offer: 0, offerCurrency: 'EUR', budget: 120, budgetCurrency: 'USD',
            onchain: { chainType: 'solana', chainId: 'solana-devnet', contractAddress: 'CaseSensitiveProgram', proposalId: 'CaseSensitiveAccount', balance: '999000000' }
        }), { baseUrl }));
        const record = nodeWithType(nodes, `${NAMESPACE}Proposal`);
        const offer = nodes.find(node => node['@id'] === ids(record, `${NAMESPACE}offeredConsideration`)[0]);
        expect(values(offer, 'https://schema.org/value')).toEqual([0]);
        expect(values(offer, 'https://schema.org/currency')).toEqual(['EUR']);
        const budget = nodes.find(node => node['@id'] === ids(record, `${NAMESPACE}budget`)[0]);
        expect(values(budget, 'https://schema.org/value')).toEqual([120]);
        expect(values(budget, 'https://schema.org/currency')).toEqual(['USD']);
        const chain = nodeWithType(nodes, `${NAMESPACE}ChainReference`);
        expect(values(chain, `${NAMESPACE}contract`)).toEqual(['CaseSensitiveProgram']);
        expect(values(chain, `${NAMESPACE}tokenId`)).toEqual(['CaseSensitiveAccount']);
        expect(JSON.stringify(nodes)).not.toContain('999000000');
    });

    it('omits an incomplete monetary or chain declaration instead of guessing its missing basis', () => {
        const doc = proposalDocument(proposal({ offer: 20, budget: '30', budgetCurrency: 'EUR', onchain: { proposalId: 'bare-token' } }), { baseUrl });
        expect(doc['cb:offeredConsideration']).toBeUndefined();
        expect(doc['cb:budget']).toBeUndefined();
        expect(doc['cb:declaredChainReference']).toBeUndefined();
    });

    it('preserves the canonical lowercase draft lifecycle rather than reclassifying it as Unknown', async () => {
        const expanded = await jsonld.expand(proposalDocument(proposal({ lifecycleStatus: 'draft' }), { baseUrl }));
        expect(ids(expanded[0], `${NAMESPACE}recordedLifecycle`)).toEqual([`${NAMESPACE}lifecycle-draft`]);
    });

    it.each([
        { type: 'Polygon', coordinates: [] },
        { type: 'Polygon', coordinates: [[[12, 45], [12.01, 45], [12.01, 45.01], [12.005, 45]]] },
        { ...site, crs: { type: 'name', properties: { name: 'EPSG:3857' } } }
    ])('refuses to label an invalid or differently referenced site as CRS84 GeoJSON', invalidSite => {
        expect(() => proposalDocument(proposal({ site: invalidSite }), { baseUrl })).toThrow();
    });

    it('lets a consumer recover ordered plan commitments with unchanged, changed and missing members', async () => {
        const a = { id: 3, proposal_id: 'three', goal: 'park', proposal_data: { site } };
        const b = { id: 2, proposal_id: 'two', goal: 'lake', proposal_data: { site } };
        const row = { slug: 'harbor-plan', proposal_ids: ['3', '2', '1'], plan_hash: 'a'.repeat(64), supersedes: 'harbor-old',
            member_hashes: { 3: memberHash(a), 2: memberHash(b), 1: 'b'.repeat(64) } };
        const doc = planDocument(row, [a, { ...b, goal: 'park' }], ['harbor-next'], { baseUrl });
        const nodes = await jsonld.flatten(doc);
        const plan = nodeWithType(nodes, `${NAMESPACE}NamedPlan`);
        const list = plan[`${NAMESPACE}memberships`][0]['@list'];
        const entries = list.map(item => nodes.find(node => node['@id'] === item['@id']));
        expect(entries.map(entry => ids(entry, `${NAMESPACE}member`)[0])).toEqual(['3', '2', '1'].map(id => `${baseUrl}/proposals/${id}#proposal`));
        expect(entries.map(entry => values(entry, `${NAMESPACE}memberChanged`)[0])).toEqual([false, true, true]);
        expect(entries.map(entry => values(entry, `${NAMESPACE}memberMissing`)[0])).toEqual([false, false, true]);
        expect(values(entries[1], `${NAMESPACE}committedMemberHash`)).toEqual([memberHash(b)]);
        expect(values(entries[1], `${NAMESPACE}currentMemberHash`)).not.toEqual([memberHash(b)]);
        expect(entries[2][`${NAMESPACE}currentMemberHash`]).toBeUndefined();
        expect(ids(plan, `${NAMESPACE}supersedes`)).toEqual([`${baseUrl}/plans/harbor-old#plan`]);
        expect(ids(plan, `${NAMESPACE}supersededBy`)).toEqual([`${baseUrl}/plans/harbor-next#plan`]);
        expect(await jsonld.toRDF(doc, { format: 'application/n-quads' })).toContain(`${CONTEXT.rdf}first`);
    });

    it('refuses malformed plan commitments rather than presenting an uncommitted membership list', () => {
        expect(() => planDocument({ slug: 'broken', proposal_ids: ['1'], member_hashes: {}, plan_hash: 'a'.repeat(64) }, [], [], { baseUrl })).toThrow(/invalid saved commitment/);
    });

    it('reports an existing but invalid readjustment member without inventing a current hash', () => {
        const row = { slug: 'invalid-current', proposal_ids: ['1'], member_hashes: { 1: 'a'.repeat(64) }, plan_hash: 'b'.repeat(64) };
        const invalidMember = { id: 1, proposal_id: 'invalid-deal', goal: 'reparcellization', reparcellization: {} };
        const doc = planDocument(row, [invalidMember], [], { baseUrl });
        const entry = doc['cb:memberships']['@list'][0];
        expect(entry['cb:memberChanged']).toBe(true);
        expect(entry['cb:memberMissing']).toBe(false);
        expect(entry['cb:memberInvalid']).toBe(true);
        expect(entry['cb:currentMemberHash']).toBeUndefined();
        expect(entry['cb:committedMemberHash']).toBe('a'.repeat(64));
    });

    it.each(['', 'relative/api', 'https://user:secret@publication.example', 'https://publication.example/?tenant=x', 'https://publication.example/#fragment', 'ftp://publication.example'])('refuses an unsuitable canonical publication base %s', value => {
        expect(() => canonicalPublicationBase(value)).toThrow(/PUBLIC_API_BASE_URL/);
    });

    it('defines every local term used by an expanded export and generates deterministic static artifacts', async () => {
        const definitions = await jsonld.flatten(vocabularyDocument());
        const defined = new Set(definitions.map(node => node['@id']));
        const expanded = await jsonld.expand(proposalDocument(proposal({ offer: 10, offerCurrency: 'EUR' }), { baseUrl }));
        function walk(value) {
            if (typeof value === 'string' && value.startsWith(NAMESPACE)) expect(defined.has(value)).toBe(true);
            else if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => { walk(key); walk(child); });
        }
        walk(expanded);
        for (const goal of designGoals.keys) walk(await jsonld.expand(proposalDocument(proposal({ goal }), { baseUrl })));
        for (const kind of decisionKinds.KINDS) walk(await jsonld.expand(proposalDocument(proposal({ kind }), { baseUrl })));
        for (const lifecycleStatus of [...LIFECYCLE_STATUSES, 'Unknown']) {
            const doc = proposalDocument(proposal({ lifecycleStatus }), { baseUrl });
            expect(doc['cb:recordedLifecycle']['@id']).toBe(`cb:lifecycle-${lifecycleStatus}`);
            walk(await jsonld.expand(doc));
        }
        walk(await jsonld.expand(planDocument({ slug: 'plan-terms', proposal_ids: ['1'],
            member_hashes: { 1: 'a'.repeat(64) }, plan_hash: 'b'.repeat(64), supersedes: 'old-plan'
        }, [{ id: 1 }], ['new-plan'], { baseUrl })));
        expect(defined.has(`${NAMESPACE}DesignGoals`)).toBe(true);
        expect(await jsonld.toRDF(vocabularyDocument(), { format: 'application/n-quads' })).toContain(`${CONTEXT.skos}inScheme`);
        for (const [path, content] of vocabularyArtifacts()) {
            expect(readFileSync(new URL(`../../frontend/vocabulary/${path}`, import.meta.url), 'utf8')).toBe(content);
        }
        const html = vocabularyArtifacts().get('1/index.html');
        for (const id of defined) if (id.startsWith(NAMESPACE)) expect(html).toContain(`id="${id.slice(NAMESPACE.length)}"`);
    });
});
