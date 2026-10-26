import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const File = require('../../frontend/js/plan-file.js');
const Design = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');
const box = (x = 15) => ({ type: 'Polygon', coordinates: [[[x, 45], [x + .001, 45], [x + .001, 45.001], [x, 45.001], [x, 45]]] });
const view = { at: '45,15,17', mode: 'model', city: 'zagreb', language: 'hr', camera: { targetLat: 45, targetLng: 15, headingDeg: 20, pitchRad: -.5, range: 300 }, settings: { existing: 'off', proposed: 'on' }, backend: 'https://private.example?token=secret' };
const park = (extra = {}) => ({ proposalId: 'original', goal: 'park', title: 'Šuma 🌳', site: box(), city: 'zagreb', author: 'A', createdAt: '2026-10-25T10:00:00.000Z', structureProposal: { kind: 'park', geometry: box(), decorationDesign: { trees: [{ x: 2, y: 3 }] } }, ...extra });
const options = { title: 'River plan', view };
function store(seed = []) {
    const records = new Map(seed.map(p => [p.proposalId, structuredClone(p)]));
    return { records, getAllProposals: () => [...records.values()], getProposal: id => records.get(id),
        importProposal: (record, options) => { if (records.has(record.proposalId) && !options.overwrite) return null; records.set(record.proposalId, structuredClone(record)); return records.get(record.proposalId); } };
}
const make = records => File.create(records || [park()], options);
const rehash = file => { file.designs.forEach(row => { row.cid = Cid.cidOfObject(row.content); }); file.designs.sort((a, b) => a.cid.localeCompare(b.cid)); file.plan.designCids = file.designs.map(row => row.cid); return file; };
function glb(json) {
    const raw = new TextEncoder().encode(JSON.stringify(json)), length = Math.ceil(raw.length / 4) * 4, data = new Uint8Array(20 + length);
    const v = new DataView(data.buffer); v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, data.length, true); v.setUint32(12, length, true); v.setUint32(16, 0x4e4f534a, true);
    data.fill(32, 20); data.set(raw, 20); return 'data:model/gltf-binary;base64,' + Buffer.from(data).toString('base64');
}
describe('portable editable plan files', () => {
    it('round trips full membership, geometry, parameters, sources, title and saved view', async () => {
        const building = { goal: 'single', title: 'Tower', site: box(15.002), buildingProposal: { floors: 6, material: 'brick' }, geometry: { buildings: [{ type: 'Feature', geometry: box(15.002), properties: { floors: 6, height: 18 } }] } };
        const file = await make([park({ binding: { parcelSource: { sourceId: 'dgu', snapshotId: '2026' } } }), building]);
        const decoded = File.parse(File.stringify(file)), target = store(); let n = 0;
        const imported = File.importInto(decoded, target, { id: () => `file-${++n}` });
        const again = await File.create(imported.memberIds.map(id => target.getProposal(id)), { title: imported.content.title, view: imported.content.view });
        expect(again).toEqual(file); expect(file.plan.designCids).toEqual(file.designs.map(r => r.cid));
        expect(file.plan.view).not.toHaveProperty('backend'); expect(imported.cid).toBe(Cid.cidOfObject(file.plan));
        for (const r of target.records.values()) { expect(r.applied).toBe(false); expect(r.lifecycleStatus).toBe('draft'); expect(r).not.toHaveProperty('published'); expect(r).not.toHaveProperty('ownerAcceptances'); }
    });
    it('uses canonical projection and excludes credentials, sessions, signatures and agreement state', async () => {
        const file = await make([park({ password: 'SECRET', session: 'PRIVATE', privateKey: 'KEY', ownerAcceptances: { x: ['signature'] }, minted: true, published: { cid: 'pub' }, agreement: { schema: 'agreement/v1' } })]);
        const text = File.stringify(file); for (const secret of ['SECRET', 'PRIVATE', 'KEY', 'ownerAcceptances', 'minted', 'signature', 'published', 'agreement/v1']) expect(text).not.toContain(secret);
        expect(file.designs[0].content).toEqual(Design.published(park()));
    });
    it('deduplicates repeated imports and preserves existing applied/edited work', async () => {
        const original = park({ proposalId: 'existing', applied: true }), target = store([original, park({ proposalId: 'edited', title: 'My changed work' })]), file = await make();
        const before = structuredClone([...target.records]);
        const a = File.importInto(file, target), b = File.importInto(file, target);
        expect(a).toEqual(b); expect(a.memberIds).toEqual(['existing']); expect([...target.records]).toEqual(before);
    });
    it('rejects an identity collision rather than replacing work', async () => {
        const target = store([park({ title: 'Other' })]);
        const file = await make();
        expect(() => File.importInto(file, target, { id: () => 'original' })).toThrow(/collision/);
        expect(target.getProposal('original').title).toBe('Other');
    });
    it('retains plan-specific source observations when reusing an existing design', async () => {
        const file = await make([park({ planFileSource: { sourceId: 'source-new', snapshotId: 'new' } })]);
        const target = store([park({ planFileSource: { sourceId: 'source-old', snapshotId: 'old' } })]);
        const result = File.importInto(file, target);
        const again = await File.create(target.getAllProposals(), { ...options, designSources: result.designSources });
        expect(again).toEqual(file); expect(target.getProposal('original').planFileSource.sourceId).toBe('source-old');
    });
    it('rejects malformed, oversized, unsupported and foreign envelope data', async () => {
        expect(() => File.parse('{')).toThrow(/JSON/); expect(() => File.parse(' '.repeat(File.MAX_BYTES + 1))).toThrow(/32 MiB/);
        for (const schema of ['ugt-plan-file/v2', 'agreement/v1', 'plan/v1']) {
            const f = await make(); f.schema = schema; expect(() => File.validate(f)).toThrow(/version/);
        }
        const f = await make(); f.agreement = {}; expect(() => File.validate(f)).toThrow(/version/);
        expect(() => File.parse('{"__proto__":{}}')).toThrow(/reserved/); expect({}.polluted).toBeUndefined();
    });
    it('checks exact members and content hashes before storage is touched', async () => {
        for (const change of [f => f.designs.pop(), f => f.designs[0].content.title = 'Changed', f => f.plan.designCids.push(f.plan.designCids[0]), f => f.designs[0].content.schema = 'design/v2']) {
            const f = await make(); change(f); const target = store(); expect(() => File.importInto(f, target)).toThrow(); expect(target.records.size).toBe(0);
        }
    });
    it('bounds geometry, nesting and all parameter data', async () => {
        for (const geometry of [{ type: 'Polygon', coordinates: [[[15,45],[16,45],[16,46],[15,46]]] }, { type: 'Point', coordinates: [181,45] }, { type: 'Polygon', coordinates: [[]] }, { type: 'Polygon', coordinates: [[[15,'45'],[16,45],[16,46],[15,'45']]] }]) {
            const f = await make(); f.designs[0].content.site = geometry; rehash(f); expect(() => File.validate(f)).toThrow();
        }
        const f = await make(); let node = f.designs[0].content.structureProposal;
        for (let i = 0; i < File.MAX_DEPTH; i++) node = node.deep = {};
        expect(() => File.validate(f)).toThrow(/complex/);
        const many = await make(), ring = Array.from({ length: File.MAX_VERTICES + 1 }, () => [15,45]); many.designs[0].content.site.coordinates = [ring]; rehash(many);
        expect(() => File.validate(many)).toThrow(/vertices/);
    });
    it('rejects nested private fields and credential-bearing URLs', async () => {
        for (const field of [{ accessToken: 'x' }, { constructor: {} }, { url: 'https://private.example/a?X-Amz-Signature=secret' }, { url: 'javascript:alert(1)' }]) {
            const f = await make(); Object.assign(f.designs[0].content.structureProposal, field); expect(() => File.validate(f)).toThrow();
        }
    });
    it('embeds model dependencies, preserves them on round trip and refuses incomplete models', async () => {
        const data = glb({ asset: { version: '2.0' }, buffers: [] }); let requests = 0;
        const model = park({ structureProposal: { kind: 'park', geometry: box(), modelUrl: 'https://assets.example/model.glb' } });
        const file = await File.create([model], { ...options, fetchModel: async () => { requests++; return data; } });
        expect(requests).toBe(1); expect(file.designs[0].content.structureProposal.modelUrl).toBe(data);
        expect(File.parse(File.stringify(file))).toEqual(file); expect(model.structureProposal.modelUrl).toMatch(/^https/);
        await expect(File.create([model], options)).rejects.toThrow(/dependency/);
        expect(() => File.checkModel(glb({ buffers: [{ uri: 'https://elsewhere/buffer.bin' }] }))).toThrow(/external/);
        expect(() => File.checkModel('data:model/gltf-binary;base64,garbage')).toThrow(/GLB/);
    });
    it('exports GeoJSON with holes, geographic roles and useful scalar attributes, without needing model assets', async () => {
        const p = park(); p.site.coordinates.push([[15.0002,45.0002],[15.0002,45.0008],[15.0008,45.0008],[15.0008,45.0002],[15.0002,45.0002]]);
        const f = await make([p]), geo = File.geojson(f);
        expect(geo.type).toBe('FeatureCollection'); expect(geo.features.find(x => x.properties.ugt_role === 'site').geometry.coordinates).toHaveLength(2);
        expect(geo.features.every(x => x.properties.ugt_design_cid === f.designs[0].cid)).toBe(true);
        expect(geo.ugt.coordinates).toContain('longitude, latitude');
        const external = park({ structureProposal: { geometry: box(), modelUrl: 'https://offline.example/model.glb' } });
        expect(File.geojsonRecords([external], options).features.length).toBeGreaterThan(0);
    });
});
