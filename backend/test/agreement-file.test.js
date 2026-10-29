// An agreement file carries the agreement with the plan file of its plan; importing it makes a
// local draft agreement over the imported designs, following each design to its CID in the file.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const AgreementFile = require('../../frontend/js/agreement-file.js');
const PlanFile = require('../../frontend/js/plan-file.js');
const Record = require('../../frontend/js/agreement-record.js');
const PlanRecord = require('../../frontend/js/plan-record.js');
const Design = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');

const box = x => ({ type: 'Polygon', coordinates: [[[x, 45], [x + .001, 45], [x + .001, 45.001], [x, 45.001], [x, 45]]] });
const park = (id, x, extra = {}) => ({ proposalId: id, goal: 'park', title: `Park ${id}`, site: box(x), city: 'zagreb', author: 'A',
    createdAt: '2026-10-25T10:00:00.000Z', structureProposal: { kind: 'park', geometry: box(x), ...extra } });
const view = { at: '45,15,17', mode: '2d' };
function glb(json) {
    const raw = new TextEncoder().encode(JSON.stringify(json)), length = Math.ceil(raw.length / 4) * 4, data = new Uint8Array(20 + length);
    const v = new DataView(data.buffer); v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, data.length, true); v.setUint32(12, length, true); v.setUint32(16, 0x4e4f534a, true);
    data.fill(32, 20); data.set(raw, 20); return 'data:model/gltf-binary;base64,' + Buffer.from(data).toString('base64');
}
function store() {
    const records = new Map();
    return { records, getAllProposals: () => [...records.values()], getProposal: id => records.get(id),
        importProposal: (record, options) => { if (records.has(record.proposalId) && !options.overwrite) return null; records.set(record.proposalId, structuredClone(record)); return records.get(record.proposalId); } };
}
function agreementOver(designs) {
    const cids = designs.map(design => Design.cidOf(design)).sort();
    const content = PlanRecord.create('River plan', cids, view);
    return Record.normalize({ schema: 'agreement/v1', id: 'ag-original', title: 'River agreement', city: 'zagreb',
        plan: { cid: Cid.cidOfObject(content), content },
        designs: designs.map(design => ({ proposalId: design.proposalId, title: design.title, goal: design.goal, cid: Design.cidOf(design) })),
        inputs: { parcels: [{ parcelId: 'A', areaM2: 1000 }], openGroundM2: 0 }, outputs: [], allocations: [], money: { currency: 'EUR', lines: [] },
        rule: { electorate: 'owners', binding: false, lens: [], approvalConfig: null, settlement: { method: 'area', rateCentsPerM2: 10000, contributionBasisPoints: 0 } },
        published: { cid: Cid.cidOfObject({ published: 1 }), publishedAt: '2026-10-26T10:00:00.000Z', apiBase: 'https://api.example' } });
}
async function fileOf(designs, fetchModel) {
    const agreement = agreementOver(designs), cidMap = {};
    const planFile = await PlanFile.create(designs, { title: agreement.plan.content.title, view, cidMap, ...(fetchModel ? { fetchModel } : {}) });
    return { agreement, file: AgreementFile.create(agreement, planFile, cidMap) };
}

describe('agreement files', () => {
    it('round trips: the import is a local draft over the imported designs, unpublished, under a new id', async () => {
        const designs = [park('p1', 15), park('p2', 15.01)];
        const { agreement, file } = await fileOf(designs);
        const parsed = AgreementFile.parse(AgreementFile.stringify(file));
        const target = store(); let n = 0;
        const imported = PlanFile.importInto(parsed.planFile, target, { id: () => `file-${++n}` });
        const local = AgreementFile.localAgreement(parsed, imported, { id: 'ag-new', now: '2026-10-30T00:00:00.000Z' });
        expect(local.id).toBe('ag-new'); expect(local.published).toBeNull(); expect(local.onchain).toBeNull();
        expect(local.title).toBe('River agreement'); expect(local.inputs).toEqual(agreement.inputs); expect(local.rule).toEqual(agreement.rule);
        expect(local.plan).toEqual(agreement.plan);
        local.designs.forEach(design => expect(Design.cidOf(target.getProposal(design.proposalId))).toBe(design.cid));
        expect(Record.validate(local).errors.map(row => row.code)).not.toContain('plan-membership');
    });
    it('follows a design whose CID changed when its model was embedded', async () => {
        const model = park('m1', 15, { modelUrl: 'https://assets.example/model.glb' });
        const { agreement, file } = await fileOf([model, park('p2', 15.01)], async () => glb({ asset: { version: '2.0' }, buffers: [] }));
        const original = Design.cidOf(model);
        expect(file.designCids[original]).not.toBe(original);
        const target = store(); let n = 0;
        const imported = PlanFile.importInto(file.planFile, target, { id: () => `file-${++n}` });
        const local = AgreementFile.localAgreement(file, imported, { id: 'ag-new' });
        expect(local.plan.cid).not.toBe(agreement.plan.cid);
        const moved = local.designs.find(design => design.title === 'Park m1');
        expect(moved.cid).toBe(file.designCids[original]);
        expect(Design.cidOf(target.getProposal(moved.proposalId))).toBe(moved.cid);
        expect(Record.validate(local).errors.map(row => row.code)).not.toContain('plan-membership');
    });
    it('refuses a file whose plan file lacks a design, holds another, or carries unknown members', async () => {
        const { file } = await fileOf([park('p1', 15), park('p2', 15.01)]);
        const missing = structuredClone(file); delete missing.designCids[Object.keys(missing.designCids)[0]];
        expect(() => AgreementFile.validate(missing)).toThrow(/missing from its plan file/);
        const extra = structuredClone(file); extra.secret = 'x';
        expect(() => AgreementFile.validate(extra)).toThrow(/unexpected members/);
        const other = (await fileOf([park('p3', 15.02)])).file;
        expect(() => AgreementFile.validate({ ...file, planFile: other.planFile })).toThrow();
        expect(() => AgreementFile.parse('{')).toThrow(/not valid JSON/);
        expect(() => AgreementFile.validate({ ...file, schema: 'ugt-plan-file/v1' })).toThrow(/Expected ugt-agreement-file\/v1/);
    });
    it('needs a plan to download', () => {
        const { plan: _plan, ...rest } = agreementOver([park('p1', 15)]);
        expect(() => AgreementFile.create({ ...rest, plan: null }, {}, {})).toThrow(/with a plan/);
    });
});
