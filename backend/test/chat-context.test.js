// Context shaping tests against the real plan, design and shared-session helpers.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { canonicalArtifact } from '../agents/shared-plan-artifact.js';
const require = createRequire(import.meta.url);
const context = require('../../frontend/js/chat/chat-context.js');
const Composition = require('../../frontend/js/plan-composition.js');
const DesignRecord = require('../../frontend/js/design-record.js');
const Session = require('../../frontend/js/shared-plan-session.js');
const Cid = require('../../frontend/js/cid.js');
const square = { type: 'Polygon', coordinates: [[[15.96,45.8],[15.961,45.8],[15.961,45.801],[15.96,45.801],[15.96,45.8]]] };
const record = (id, title = 'Park') => ({ proposalId: id, goal: 'park', title, description: '', author: 'Ana', city: 'london', site: square, toleranceM: .5,
    geometry: square, createdAt: '2026-10-21T10:00:00Z', structureProposal: { kind: 'park', geometry: square, trees: 3 }, applied: true });
const view = { at: '45.8,15.96,17', mode: '2d', city: 'london', language: 'en' };
const funcs = { cidOf: DesignRecord.cidOf, isApplied: r => r.applied === true };

describe('chat plan context', () => {
    it('omits the artifact for unchanged applied member CIDs and includes it for a changed member', () => {
        const a = record('a'), b = record('b', 'Square');
        const first = Composition.create('Working', [a], view);
        expect(context.planPayload({ row: first, lastSynced: first, artifactOf: Session.artifactOf })).toEqual({ planCid: first.cid });
        const changed = context.currentPlanRow({ records: [b], lastSynced: first, view, title: 'Working', ...funcs, compose: Composition.create });
        expect(context.planPayload({ row: changed, lastSynced: first, artifactOf: Session.artifactOf })).toMatchObject({ planCid: changed.cid, planArtifact: { cid: changed.cid, plan: expect.any(Object), designs: expect.any(Array) } });
        expect(context.planPayload({ row: changed, lastSynced: null, artifactOf: Session.artifactOf }).planArtifact).toBeTruthy();
    });
    it('sends the canonical artifact shape accepted by the shared plan server', () => {
        const design = record('canonical-local', 'Canonical park');
        const row = Composition.create('Canonical plan', [design], view);
        const payload = context.planPayload({ row, lastSynced: null, artifactOf: Session.artifactOf });
        expect(canonicalArtifact(payload.planArtifact)).toMatchObject({ cid: row.cid, plan: row.content, designs: [{ cid: row.designs[0].cid, content: row.designs[0].content }] });
    });
    it('preserves per-member parcel sources from private drafts', () => {
        const loaded = { plan: { schema: 'plan/v1', designCids: [] }, designs: [{ cid: 'member-cid', content: { schema: 'design/v1' } }],
            parcelSourceId: 'default-source', designSources: { 'member-cid': 'member-source' } };
        expect(context.artifactFromDraft(loaded, { cidOf: () => 'member-cid', cid: 'plan-cid' }).designs[0].parcelSourceId).toBe('member-source');
    });
    it('carries plan member identities by CID and computes the change from relayed CIDs', () => {
        const first = Composition.create('Working', [record('a')], view);
        const loaded = Session.artifactOf(first);
        const artifact = context.artifactFromDraft(loaded, { cidOf: DesignRecord.cidOf, cid: first.cid });
        const next = context.nextRowFromDraft(artifact, first, { rowOf: Session.rowOf });
        expect(next.memberIds).toEqual(first.memberIds);
        expect(() => context.nextRowFromDraft({ ...artifact, cid: 'wrong-cid' }, first, { rowOf: Session.rowOf })).toThrow(/does not match/);
        expect(context.lastChangeOf(first, next, [{ beforeCid: first.designs[0].cid, afterCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty' }])).toMatchObject({ fromCid: first.cid, toCid: next.cid, members: [{ beforeCid: first.designs[0].cid }] });
    });
    it('keeps canonical private draft CIDs without reserializing them as local records', () => {
        const first = Composition.create('Working', [record('a')], view);
        const loaded = { plan: first.content, designs: first.designs.map(member => member.content), parcelSourceId: 'private-source' };
        const artifact = context.artifactFromDraft(loaded, { cidOf: Cid.cidOfObject, cid: first.cid });
        const next = context.nextRowFromDraft(artifact, null, { rowOf: Session.rowOf });
        expect(next.designs.map(member => member.cid)).toEqual(first.content.designCids);
        expect(next.designs[0].content).toEqual(loaded.designs[0]);
    });
    it('parses a design reference and optional building index', () => {
        expect(context.parseRef('design:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty')).toEqual({ designCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty' });
        expect(context.parseRef('building:bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty:0')).toEqual({ designCid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq4xw2gq2l5ty', buildingIndex: 0 });
        expect(context.parseRef('design/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3rj6g5z4q3f7zq2l5ty/2')).toBeNull();
    });
});
