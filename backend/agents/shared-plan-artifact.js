import { cidOfObject } from '../cid.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PlanRecord = require('../../frontend/js/plan-record.js');
const DesignRecord = require('../../frontend/js/design-record.js');

export function canonicalArtifact(value) {
    const plan = value?.plan?.content || value?.plan;
    const designs = value?.designs;
    if (!plan || PlanRecord.validate(plan) || cidOfObject(plan) !== value?.cid || !Array.isArray(designs) || designs.length !== plan.designCids.length) {
        throw Object.assign(new Error('A shared plan needs one exact plan/v1 and all of its exact design/v1 members.'), { code: 'shared-plan-artifact-invalid', status: 400 });
    }
    const rows = designs.map(row => ({ cid: row?.cid || cidOfObject(row?.content || row), content: row?.content || row, parcelSourceId: row?.parcelSourceId || null }));
    if (new Set(rows.map(row => row.cid)).size !== rows.length || rows.some(row => row.cid !== cidOfObject(row.content) || !DesignRecord.validate(row.content).valid
        || (row.parcelSourceId !== null && (typeof row.parcelSourceId !== 'string' || !row.parcelSourceId)))
        || rows.some(row => !plan.designCids.includes(row.cid) || (row.parcelSourceId !== null && (typeof row.parcelSourceId !== 'string' || row.parcelSourceId.length > 200)))) throw Object.assign(new Error('Shared plan members must exactly match the plan commitment.'), { code: 'shared-plan-artifact-invalid', status: 400 });
    return { cid: value.cid, plan: structuredClone(plan), designs: structuredClone(rows) };
}
