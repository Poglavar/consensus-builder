import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import * as turf from '@turf/turf';
import { cidOfObject } from '../cid.js';
import { prepareBogotaDemo, replayBogotaPlan, PARCEL_IDS, SYNTHETIC_AUTHORITY_ID } from '../scripts/prepare-bogota-agreement-demo.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AgreementRecord = require('../../frontend/js/agreement-record.js');
const PlanFile = require('../../frontend/js/plan-file.js');
const ApprovalRegimes = require('../../frontend/js/proposals/approval-regimes.js');
const saved = JSON.parse(await readFile(new URL('../../docs/demo/bogota-agreements/sampledata.json', import.meta.url), 'utf8'));
const features = saved.ground.map(parcel => ({ id: parcel.parcelId, geometry: parcel.geometry,
    properties: { sourceProperties: parcel.sourceAttributes } }));
const feature = geometry => turf.feature(geometry);
const area = geometry => turf.area(feature(geometry));

describe('Bogotá agreement sample preparation', () => {
    it('pins current Colombian readjustment rules and exports an importable matching rights file', async () => {
        const sample = await prepareBogotaDemo(features);
        const owner = sample.agreements[0].content;
        const expectedRegime = ApprovalRegimes.latest('co-readjustment');
        expect(owner.rule.approvalConfig.regime).toEqual({ id: expectedRegime.id, version: expectedRegime.version });
        expect(owner.rule.approvalConfig.policy).toEqual(ApprovalRegimes.policyOf(expectedRegime, [SYNTHETIC_AUTHORITY_ID]));
        expect(owner.rule.approvalConfig.rights.source).toEqual({ provider: 'upload', reference: 'bogota-demo-synthetic-rights-v1' });
        expect(sample.ownership).toEqual(owner.rule.approvalConfig.rights);
        const replayAreas = new Map(sample.replay.inputs.parcels.map(parcel => [parcel.parcelId, parcel.areaM2]));
        for (const row of sample.ownership.parcels) {
            expect(row.areaM2).toBe(replayAreas.get(row.parcelId));
        }
        expect(sample.ownership.parcels.find(row => row.parcelId === PARCEL_IDS[2]).owners)
            .toEqual([{ ownerId: 'DEMO-PERSON-BRUNO', share: '1/2' }, { ownerId: 'DEMO-PERSON-CAMILA', share: '1/2' }]);
    });

    it('uses the portable plan’s canonical membership and exact snapshot in every agreement', async () => {
        const sample = await prepareBogotaDemo(features);
        const planCid = cidOfObject(sample.planFile.plan);
        expect(sample.planFile.schema).toBe('ugt-plan-file/v1');
        expect(() => PlanFile.validate(sample.planFile)).not.toThrow();
        expect(sample.agreements.map(row => row.content.planCid)).toEqual([planCid, planCid, planCid]);
        expect(sample.planFile.plan.designCids).toEqual(sample.planFile.designs.map(row => row.cid));
        for (const member of sample.planFile.designs) expect(cidOfObject(member.content)).toBe(member.cid);
        const payload = { cid: sample.agreements[0].cid, content: sample.agreements[0].content,
            plan: { cid: planCid, content: sample.planFile.plan }, designs: sample.planFile.designs };
        expect(Object.keys(payload).sort()).toEqual(['cid', 'content', 'designs', 'plan']);
        expect(payload.content.planCid).toBe(payload.plan.cid);
        expect(payload.designs.map(row => row.cid)).toEqual(payload.plan.content.designCids);
    });

    it('tiles the real source pool with the public space and buildable plots, and contains the building', async () => {
        const sample = await prepareBogotaDemo(features);
        const plan = sample.planFile;
        const layout = plan.designs.find(row => row.content.goal === 'parcel-layout').content;
        const park = plan.designs.find(row => row.content.goal === 'square').content;
        const building = plan.designs.find(row => row.content.goal === 'single').content;
        const plots = layout.parcelLayout.plots;
        const siteArea = area(layout.parcelLayout.pool);
        expect(layout.parcelLayout.pool).toEqual(layout.site);
        expect(Math.abs(plots.reduce((sum, plot) => sum + area(plot.geometry), 0) - siteArea)).toBeLessThan(0.03);
        let merged = feature(plots[0].geometry);
        for (const plot of plots.slice(1)) merged = turf.union(merged, feature(plot.geometry));
        expect(Math.abs(area(merged.geometry) - siteArea)).toBeLessThan(0.03);
        expect(turf.difference(feature(layout.parcelLayout.pool), merged)).toBeNull();
        expect(turf.difference(merged, feature(layout.parcelLayout.pool))).toBeNull();
        expect(park.structureProposal.geometry).toEqual(plots[0].geometry);
        const buildingFootprint = building.geometry.buildings[0].geometry;
        expect(turf.booleanWithin(feature(buildingFootprint), feature(plots[2].geometry))).toBe(true);
        expect(area(buildingFootprint)).toBeGreaterThan(0.5 * area(plots[2].geometry));
        expect(turf.lineIntersect(turf.polygonToLine(feature(plots[0].geometry)),
            turf.polygonToLine(feature(sample.ground[0].geometry))).features.length).toBeGreaterThanOrEqual(2);
        const [original, counter] = sample.agreements;
        const replay = await replayBogotaPlan(plan, sample.ground);
        const replayHashes = replay.outputs.map(output => output.hash).sort();
        expect(original.content.outputs.map(output => output.hash).sort()).toEqual(replayHashes);
        expect(sample.replay.outputs.map(output => output.hash).sort()).toEqual(replayHashes);
        expect(Math.abs(original.content.outputs.reduce((sum, output) => sum + output.areaM2, 0) - siteArea)).toBeLessThan(0.03);
        expect(original.content.outputs.some(output => output.hash === AgreementRecord.outputHash(plots[0].geometry))).toBe(true);
        const inputValues = new Map(original.content.valuation.inputs.map(row => [row.parcelId, row.unitValueCents]));
        const outputValues = new Map(original.content.valuation.outputs.map(row => [row.output, row.unitValueCents]));
        for (const output of original.content.outputs) {
            const replayOutput = replay.outputs.find(row => row.hash === output.hash);
            expect(output.areaM2).toBeCloseTo(replayOutput.areaM2, 6);
            const sourceAreas = output.fromParcelIds.map(parcelId => {
                const sourceParcel = sample.ground.find(parcel => parcel.parcelId === parcelId);
                const overlap = turf.intersect(feature(replayOutput.geometry), feature(sourceParcel.geometry));
                return { parcelId, areaM2: overlap ? area(overlap.geometry) : 0 };
            }).filter(row => row.areaM2 > 0);
            const weightedValue = Math.round(sourceAreas.reduce((sum, row) => sum + inputValues.get(row.parcelId) * row.areaM2, 0)
                / sourceAreas.reduce((sum, row) => sum + row.areaM2, 0));
            expect(outputValues.get(output.hash)).toBe(weightedValue);
        }
        expect(original.content.allocations.find(row => row.output === AgreementRecord.outputHash(plots[0].geometry)).to)
            .toEqual({ kind: 'public' });
        expect(counter.content.outputs.map(row => row.hash)).toEqual(original.content.outputs.map(row => row.hash));
    });

    it('holds valuation constant while the counter-agreement changes exactly one output recipient', async () => {
        const sample = await prepareBogotaDemo(features);
        const [original, counter] = sample.agreements.map(row => row.content);
        expect(original.valuation).toEqual(counter.valuation);
        const byOutput = agreement => new Map(agreement.allocations.map(row => [row.output, row.to]));
        const before = byOutput(original), after = byOutput(counter);
        const changed = [...before.keys()].filter(key => JSON.stringify(before.get(key)) !== JSON.stringify(after.get(key)));
        expect(changed).toHaveLength(1);
        expect(original.outputs.find(row => row.hash === changed[0]).fromParcelIds).toContain(PARCEL_IDS[1]);
    });

    it('keeps invented example vote codes private while the community object carries only hashes', async () => {
        const sample = await prepareBogotaDemo(features);
        const community = sample.agreements[2].content;
        expect(community.rule).toMatchObject({ electorate: 'community', binding: false, approvalConfig: null });
        expect(community.consultation.voting.codeHashes).toHaveLength(sample.privateExampleVoterList.entries.length);
        for (const row of sample.privateExampleVoterList.entries) {
            expect(community.consultation.voting.codeHashes).not.toContain(row.code);
            expect(JSON.stringify(sample.agreements)).not.toContain(row.code);
        }
    });

    it('rejects missing source lots and disconnected ground', async () => {
        await expect(prepareBogotaDemo(features.slice(1))).rejects.toThrow(/missing/);
        const disconnected = features.map((row, index) => index === 3 ? { ...row,
            geometry: { type: 'Polygon', coordinates: [[[-73.9,4.61],[-73.8999,4.61],[-73.8999,4.6101],[-73.9,4.6101],[-73.9,4.61]]] } } : row);
        await expect(prepareBogotaDemo(disconnected)).rejects.toThrow(/adjoining/);
    });
});
