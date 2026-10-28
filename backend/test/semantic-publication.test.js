// JSON-LD of published designs and agreements (semantics/published-records.js, plan-design-agreement.md
// M2): a record's IRI is its CID under the canonical PUBLIC_API_BASE_URL, only its CID-addressed
// content speaks for it, and every local term an expanded export uses is defined in the published
// vocabulary (semantics/vocabulary.js, regenerated into frontend/vocabulary by build-vocabulary.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import jsonld from 'jsonld';
import {
    agreementDocument, canonicalPublicationBase, designDocument, SEMANTIC_BASE_ERROR, SEMANTIC_RECORD_ERROR
} from '../semantics/published-records.js';
import { CONTEXT, DECISION_RULES, NAMESPACE, decisionRuleOf, designGoals, vocabularyDocument } from '../semantics/vocabulary.js';
import { vocabularyArtifacts } from '../scripts/build-vocabulary.mjs';
import { agreementContent, cidOf, designContent, layoutContent, SITE } from './helpers/content-fixtures.js';

const baseUrl = 'https://publication.example/api';
const designRow = (content = designContent()) => ({ cid: cidOf(content), content, city: 'ignored-column', title: 'ignored column' });
const agreementRowOf = (content) => ({ cid: cidOf(content), content, deadline: '2001-02-03T04:05:06.000Z', status: 'expired' });
const nodeWithType = (nodes, type) => nodes.find(node => node['@type']?.includes(type));
const values = (node, property) => (node[property] || []).map(value => value['@value']);
const ids = (node, property) => (node[property] || []).map(value => value['@id']);

describe('a published design as JSON-LD', () => {
    it('is identified by its CID under the publication base, with its goal, labels and site', async () => {
        const content = designContent();
        const cid = cidOf(content);
        const doc = designDocument(designRow(content), { baseUrl });
        expect(doc['@id']).toBe(`${baseUrl}/designs/${cid}#design`);
        expect(doc['schema:url']).toEqual({ '@id': `${baseUrl}/designs/${cid}?format=jsonld` });
        expect(doc['cb:cid']).toBe(cid);

        const nodes = await jsonld.flatten(doc);
        const design = nodeWithType(nodes, `${NAMESPACE}Design`);
        expect(design['@type']).toEqual(expect.arrayContaining(['https://schema.org/CreativeWork', `${CONTEXT.prov}Entity`]));
        expect(values(design, 'https://schema.org/name')).toEqual(['Riverside park']);
        expect(values(design, 'https://schema.org/description')).toEqual(['A park on the river bank.']);
        expect(values(design, `${NAMESPACE}authorLabel`)).toEqual(['Studio North']);
        expect(values(design, 'https://schema.org/dateCreated')).toEqual([content.authoredAt]);
        expect(values(design, `${NAMESPACE}declaredGoal`)).toEqual(['park']);
        expect(ids(design, `${NAMESPACE}designGoal`)).toEqual([`${NAMESPACE}goal-park`]);
        const geometry = nodeWithType(nodes, `${CONTEXT.geo}Geometry`);
        const serialization = geometry[`${CONTEXT.geo}asGeoJSON`][0];
        expect(serialization['@type']).toBe(`${CONTEXT.geo}geoJSONLiteral`);
        expect(JSON.parse(serialization['@value'])).toEqual(SITE);
        expect(nodeWithType(nodes, `${NAMESPACE}DesignSite`)['@id']).toBe(`${baseUrl}/designs/${cid}#site`);
    });

    it('links a fork to the design it came from, by CID', () => {
        const original = designContent({ title: 'Original' });
        const fork = designContent({ origin: { cid: cidOf(original) } });
        expect(designDocument(designRow(fork), { baseUrl })['prov:wasDerivedFrom'])
            .toEqual({ '@id': `${baseUrl}/designs/${cidOf(original)}#design` });
        expect(designDocument(designRow(original), { baseUrl })).not.toHaveProperty('prov:wasDerivedFrom');
    });

    it('says nothing the content does not: no index columns, no unknown goal concept, no injected terms', async () => {
        const content = designContent({ goal: 'custom-shape', site: null, geometry: { type: 'Polygon', coordinates: SITE.coordinates } });
        const doc = designDocument({ ...designRow(content), city: 'zagreb', binding: { parcels: [{ parcelId: 'HR-1-1' }] },
            content: { ...content, '@context': { evil: 'https://injected.example/' }, 'evil:owner': 'someone', applied: true } }, { baseUrl });
        expect(doc['cb:designGoal']).toBeUndefined();
        expect(doc['cb:declaredGoal']).toBe('custom-shape');
        expect(doc['cb:site']).toBeUndefined();
        const rdf = await jsonld.toRDF(doc, { format: 'application/n-quads' });
        expect(rdf).toContain('custom-shape');
        expect(rdf).not.toMatch(/injected|someone|applied|zagreb|HR-1-1|ignored/);
    });

    it('scopes identical CIDs to their publication stores', () => {
        const a = designDocument(designRow(), { baseUrl });
        const b = designDocument(designRow(), { baseUrl: 'https://second.example/api/' });
        expect(a['@id']).not.toBe(b['@id']);
        expect(b['@id']).toBe(`https://second.example/api/designs/${cidOf(designContent())}#design`);
    });

    it.each([
        { type: 'Polygon', coordinates: [] },
        { type: 'Polygon', coordinates: [[[12, 45], [12.01, 45], [12.01, 45.01], [12.005, 45]]] },
        { ...SITE, crs: { type: 'name', properties: { name: 'EPSG:3857' } } }
    ])('refuses to label an invalid or differently referenced site as CRS84 GeoJSON', site => {
        expect(() => designDocument(designRow(designContent({ site })), { baseUrl }))
            .toThrow(expect.objectContaining({ code: SEMANTIC_RECORD_ERROR, status: 422 }));
    });

    it('refuses a row that is not a published design', () => {
        const content = designContent();
        for (const row of [{ cid: 'design-7', content }, { cid: cidOf(content), content: { ...content, schema: 'agreement/v1' } },
            { cid: cidOf(content), content: null }, null]) {
            expect(() => designDocument(row, { baseUrl })).toThrow(expect.objectContaining({ code: SEMANTIC_RECORD_ERROR, status: 422 }));
        }
    });
});

describe('a published agreement as JSON-LD', () => {
    const park = designContent();
    const layout = layoutContent();

    it('links its exact plan, rule, deadline and input parcels', async () => {
        const content = agreementContent([layout, park]);
        const cid = cidOf(content);
        const doc = agreementDocument(agreementRowOf(content), { baseUrl });
        expect(doc['@id']).toBe(`${baseUrl}/agreements/${cid}#agreement`);
        expect(doc['cb:cid']).toBe(cid);
        expect(doc['cb:plan']).toEqual({ '@id': `${baseUrl}/plans/${content.planCid}#plan` });
        expect(doc).not.toHaveProperty('cb:designs');
        expect(doc['cb:decisionRule']).toEqual({ '@id': 'cb:rule-owner-deal' });
        expect(doc['cb:agreementDeadline']).toEqual({ '@value': '2099-01-01T00:00:00.000Z', '@type': 'xsd:dateTime' });
        expect(doc['cb:cadastreReference'].map(reference => [reference['@id'], reference['cb:declaredIdentifier']])).toEqual([
            [`${baseUrl}/agreements/${cid}#cadastre-HR-335649-100`, 'HR-335649-100'],
            [`${baseUrl}/agreements/${cid}#cadastre-HR-335649-101`, 'HR-335649-101']
        ]);

        const nodes = await jsonld.flatten(doc);
        const agreement = nodeWithType(nodes, `${NAMESPACE}Agreement`);
        expect(values(agreement, 'https://schema.org/name')).toEqual(['Riverside deal']);
        expect(values(agreement, 'https://schema.org/dateCreated')).toEqual([content.createdAt]);
        expect(agreement[`${NAMESPACE}plan`]).toEqual([{ '@id': `${baseUrl}/plans/${content.planCid}#plan` }]);
        expect(await jsonld.toRDF(doc, { format: 'application/n-quads' })).toContain(`${baseUrl}/plans/${content.planCid}#plan`);
    });

    it('takes its status from nothing but its content: the index\'s columns do not speak for it', async () => {
        const content = agreementContent([park], { deadline: null });
        const doc = agreementDocument({ ...agreementRowOf(content), onchain: { proposalId: 'not-in-content' } }, { baseUrl });
        expect(doc['cb:agreementDeadline']).toBeUndefined();
        const rdf = await jsonld.toRDF(doc, { format: 'application/n-quads' });
        expect(rdf).not.toMatch(/expired|2001-02-03|not-in-content/);
    });

    it.each([
        [{ electorate: 'owners', binding: true, lens: [] }, 'owner-deal'],
        [{ electorate: 'owners', binding: false, lens: [] }, 'owner-vote'],
        [{ electorate: 'community', binding: false, lens: [] }, 'community-vote'],
        [{ electorate: 'community', binding: true, lens: [] }, null],
        [{ electorate: 'residents', binding: false, lens: [] }, null]
    ])('names the decision rule of %j as %s', (rule, key) => {
        expect(decisionRuleOf(rule)).toBe(key);
        const doc = agreementDocument(agreementRowOf(agreementContent([park], { rule })), { baseUrl });
        expect(doc['cb:decisionRule']).toEqual(key ? { '@id': `cb:rule-${key}` } : undefined);
    });

    it('escapes a parcel id in its scoped IRI and keeps it exact as the declared identifier', () => {
        const content = agreementContent([park], { inputs: { parcels: [{ parcelId: 'HR-335649-1021/3', areaM2: 10, holders: [{ ownerKey: 'a', share: 1 }] }], openGroundM2: 0 } });
        const [reference] = agreementDocument(agreementRowOf(content), { baseUrl })['cb:cadastreReference'];
        expect(reference['@id']).toBe(`${baseUrl}/agreements/${cidOf(content)}#cadastre-HR-335649-1021%2F3`);
        expect(reference['cb:declaredIdentifier']).toBe('HR-335649-1021/3');
    });

    it('refuses an agreement whose designs or input parcels are not identified', () => {
        const noCid = agreementContent([park]);
        noCid.planCid = 'plan-1';
        const noParcelId = agreementContent([park]);
        noParcelId.inputs.parcels[0] = { ...noParcelId.inputs.parcels[0], parcelId: '' };
        for (const content of [noCid, noParcelId]) {
            expect(() => agreementDocument(agreementRowOf(content), { baseUrl })).toThrow(expect.objectContaining({ code: SEMANTIC_RECORD_ERROR, status: 422 }));
        }
        expect(() => agreementDocument({ cid: cidOf(park), content: park }, { baseUrl })).toThrow(/not agreement\/v1 content/);
    });
});

describe('the publication base', () => {
    it.each(['', 'relative/api', 'https://user:secret@publication.example', 'https://publication.example/?tenant=x', 'https://publication.example/#fragment', 'ftp://publication.example'])('refuses an unsuitable canonical publication base %s', value => {
        expect(() => canonicalPublicationBase(value)).toThrow(/PUBLIC_API_BASE_URL/);
        expect(() => designDocument(designRow(), { baseUrl: value })).toThrow(expect.objectContaining({ code: SEMANTIC_BASE_ERROR, status: 503 }));
        expect(() => agreementDocument(agreementRowOf(agreementContent([designContent()])), { baseUrl: value })).toThrow(expect.objectContaining({ code: SEMANTIC_BASE_ERROR }));
    });

    it('drops a trailing slash', () => {
        expect(canonicalPublicationBase('https://publication.example/api///')).toBe('https://publication.example/api');
    });
});

describe('the published vocabulary', () => {
    it('defines every local term an expanded export uses, and generates the static artifacts deterministically', async () => {
        const definitions = await jsonld.flatten(vocabularyDocument());
        const defined = new Set(definitions.map(node => node['@id']));
        function walk(value) {
            if (typeof value === 'string' && value.startsWith(NAMESPACE)) expect(defined.has(value), value).toBe(true);
            else if (Array.isArray(value)) value.forEach(walk);
            else if (value && typeof value === 'object') Object.entries(value).forEach(([key, child]) => { walk(key); walk(child); });
        }
        const original = designContent({ title: 'Original' });
        walk(await jsonld.expand(designDocument(designRow(designContent({ origin: { cid: cidOf(original) } })), { baseUrl })));
        for (const goal of designGoals.keys) walk(await jsonld.expand(designDocument(designRow(designContent({ goal })), { baseUrl })));
        for (const rule of DECISION_RULES) {
            const doc = agreementDocument(agreementRowOf(agreementContent([original], { rule: { electorate: rule.electorate, binding: rule.binding, lens: [] } })), { baseUrl });
            expect(doc['cb:decisionRule']).toEqual({ '@id': `cb:rule-${rule.key}` });
            walk(await jsonld.expand(doc));
        }
        for (const term of ['Design', 'Agreement', 'Plan', 'DesignSite', 'CadastreReference', 'cid', 'plan', 'decisionRule', 'DecisionRules', 'DesignGoals']) {
            expect(defined.has(`${NAMESPACE}${term}`), term).toBe(true);
        }
        // The proposal, plan and lifecycle terms went with the proposal records.
        for (const retired of ['Proposal', 'NamedPlan', 'memberships', 'recordedLifecycle', 'decisionKind', 'proposalRowId']) {
            expect(defined.has(`${NAMESPACE}${retired}`), retired).toBe(false);
        }
        expect(await jsonld.toRDF(vocabularyDocument(), { format: 'application/n-quads' })).toContain(`${CONTEXT.skos}inScheme`);
        for (const [path, content] of vocabularyArtifacts()) {
            expect(readFileSync(new URL(`../../frontend/vocabulary/${path}`, import.meta.url), 'utf8'), path).toBe(content);
        }
        const html = vocabularyArtifacts().get('1/index.html');
        for (const id of defined) if (id.startsWith(NAMESPACE)) expect(html).toContain(`id="${id.slice(NAMESPACE.length)}"`);
    });
});
