// Metadata cleanup must preserve geometry, canonical identities and protected decisions.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { designContent } from './helpers/content-fixtures.js';
const require = createRequire(import.meta.url);
const Cid = require('../../frontend/js/cid.js');
const Cleaner = require('../../frontend/js/publication-label-cleanup.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const DesignSync = require('../../frontend/js/proposals/design-sync.js');
const row = content => ({ cid: Cid.cidOfObject(content), content });
const snapshot = designs => ({ designs, plans: [], agreements: [], references: {} });

describe('concept label cleanup', () => {
    it.each([
        ['CONCEPT District — park', 'District — park'],
        ['Courtyard (concept)', 'Courtyard'],
        ['CONCEPT ONLY: A garden.', 'A garden.'],
        ['Concept only. A street.', 'A street.'],
        ['Studio Concept 2', 'Studio 2'],
        ['A conceptual design', 'A conceptual design']
    ])('cleans whole labels without damaging neighbouring words: %s', (before, after) => {
        expect(Cleaner.cleanText(before)).toBe(after);
    });
    it('changes label fields but never source URLs, coordinates or other authored properties', () => {
        const before = { title: 'CONCEPT Park', source: 'https://example.test/concept', geometry: {
            type: 'Point', coordinates: [1, 2], properties: { name: 'Concept garden', height: 6 }
        } };
        const after = Cleaner.cleanLabels(before);
        expect(after.title).toBe('Park');
        expect(after.geometry.properties.name).toBe('garden');
        expect(after.source).toBe(before.source);
        expect(after.geometry.coordinates).toEqual(before.geometry.coordinates);
        expect(after.geometry.properties.height).toBe(6);
        expect(before.title).toBe('CONCEPT Park');
    });
    it('recreates origins and sorted plan membership, then updates agreement producer references without changing terms', () => {
        const parent = row({ title: 'CONCEPT Parent', geometry: { type: 'Point', coordinates: [1, 2] } });
        const child = row({ title: 'Child', origin: { cid: parent.cid }, geometry: { type: 'Point', coordinates: [3, 4] } });
        const plan = row({ title: 'Garden (concept)', designCids: [parent.cid, child.cid].sort(), view: {} });
        const agreement = row({ title: 'Terms', planCid: plan.cid, outputs: [{ producedBy: child.cid, geometry: child.content.geometry }], money: { amount: 0 } });
        const changes = Cleaner.buildRevisions({ designs: [child, parent], plans: [plan], agreements: [agreement], references: {} });
        const revisedChild = changes.designs.find(change => change.from === child.cid);
        expect(revisedChild.content.origin.cid).toBe(changes.mappings[parent.cid]);
        expect(changes.plans[0].content).toMatchObject({ title: 'Garden', designCids: changes.designs.map(d => d.to).sort() });
        expect(changes.agreements[0].content.outputs[0].producedBy).toBe(revisedChild.to);
        expect(changes.agreements[0].content.money).toEqual(agreement.content.money);
        for (const change of [...changes.designs, ...changes.plans, ...changes.agreements]) expect(Cid.cidOfObject(change.content)).toBe(change.to);
        expect(revisedChild.content.geometry).toEqual(child.content.geometry);
    });
    it('is a no-op after the cleaned records replace their originals', () => {
        const before = snapshot([row({ title: 'Concept park', description: 'Concept only. Garden.' })]);
        const changes = Cleaner.buildRevisions(before);
        const again = Cleaner.buildRevisions(snapshot(changes.designs.map(change => ({ cid: change.to, content: change.content }))));
        expect(again.designs).toEqual([]);
    });
    it('refuses invalid source hashes, chain commitments or dependent decisions', () => {
        expect(() => Cleaner.buildRevisions(snapshot([{ cid: 'wrong', content: {} }]))).toThrow('Invalid source');
        expect(() => Cleaner.buildRevisions({ ...snapshot([]), agreements: [{ ...row({ title: 'Terms' }), onchain: {} }] })).toThrow('minted');
        expect(() => Cleaner.buildRevisions({ ...snapshot([]), references: { agreement_decision: 1 } })).toThrow('decisions');
    });
    it('updates current browser rows without changing their ids, applied state, geometry or publication validity', () => {
        const original = row(designContent({ title: 'CONCEPT Park', author: 'Studio Concept', description: 'Concept only. A garden.' }));
        const revisions = Cleaner.buildRevisions(snapshot([original]));
        const record = { ...DesignSync.localDesignFromRow(original, { apiBase: 'https://api.example.test' }), applied: true };
        const rows = [{ key: `proposal:${record.proposalId}`, value: JSON.stringify(record) },
            { key: 'cadastre_proposals', value: 'abandoned blob stays unread' }];
        const changes = Cleaner.workspaceChanges(rows, revisions.mappings, { DesignRecord });
        expect(changes).toHaveLength(1);
        const next = JSON.parse(changes[0].value);
        expect(next.proposalId).toBe(record.proposalId);
        expect(next.applied).toBe(true);
        expect(next.structureProposal.geometry).toEqual(record.structureProposal.geometry);
        expect(next.title).toBe('Park');
        expect(next.published.cid).toBe(DesignRecord.cidOf(next));
    });
    it('does not call an edited local draft published merely because its old publication was renamed', () => {
        const original = row(designContent({ title: 'CONCEPT Park' }));
        const revisions = Cleaner.buildRevisions(snapshot([original]));
        const record = DesignSync.localDesignFromRow(original, { apiBase: 'https://api.example.test' });
        record.title = 'CONCEPT Edited park';
        const changes = Cleaner.workspaceChanges([{ key: `proposal:${record.proposalId}`, value: JSON.stringify(record) }], revisions.mappings, { DesignRecord });
        expect(JSON.parse(changes[0].value)).not.toHaveProperty('published');
    });
});
