// formation-depth.js — the flat-record invariant: a published record is at most
// base cadastral parcel → one formation → content. Formations declare base ground only;
// content may stand on a formed parcel (that IS the third level).

import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let fd;

beforeAll(() => {
    fd = require('../../frontend/js/proposals/formation-depth.js');
});

const BASE = 'HR-335550-1791/25';
const SLICE = `${BASE}#p-upu-borovje-parcelacija-1`;
const NESTED = `${SLICE}#c-road-2`;

describe('id depth', () => {
    it('counts generations and finds the base', () => {
        expect(fd.parcelIdDepth(BASE)).toBe(0);
        expect(fd.parcelIdDepth(SLICE)).toBe(1);
        expect(fd.parcelIdDepth(NESTED)).toBe(2);
        expect(fd.isBaseParcelId(BASE)).toBe(true);
        expect(fd.isBaseParcelId(SLICE)).toBe(false);
        expect(fd.baseParcelIdOf(NESTED)).toBe(BASE);
        expect(fd.baseParcelIdOf(BASE)).toBe(BASE);
    });
});

describe('role', () => {
    it('is formation when the record actually minted ground', () => {
        expect(fd.roleOf({ goal: 'single', childParcelIds: [`${BASE}#c-x-1`] })).toBe('formation');
    });

    it('is content when a forming goal minted nothing (it fits a plot someone else formed)', () => {
        expect(fd.roleOf({ goal: 'single', parentParcelIds: [SLICE], childParcelIds: [] })).toBe('potential-formation');
        expect(fd.roleOf({ goal: 'urban-rule', parentParcelIds: [SLICE] })).toBe('content');
    });

    it('reads children from typology sub-objects too', () => {
        expect(fd.roleOf({ goal: 'road-track', roadProposal: { childParcelIds: [`${BASE}#c-r-1`] } })).toBe('formation');
    });
});

describe('conformance', () => {
    it('accepts a formation standing on base ground', () => {
        const verdict = fd.conformanceOf({
            goal: 'road-track',
            parentParcelIds: [BASE],
            roadProposal: { parentParcelIds: [BASE], childParcelIds: [`${BASE}#c-road-1`] }
        });
        expect(verdict.flat).toBe(true);
        expect(verdict.role).toBe('formation');
    });

    it('accepts content standing on a formed parcel — that is the third level', () => {
        const verdict = fd.conformanceOf({ goal: 'urban-rule', parentParcelIds: [SLICE] });
        expect(verdict.flat).toBe(true);
        expect(verdict.maxParentDepth).toBe(1);
    });

    it('rejects a formation standing on formed ground (the chain the invariant forbids)', () => {
        const verdict = fd.conformanceOf({
            goal: 'road-track',
            parentParcelIds: [SLICE],
            roadProposal: { parentParcelIds: [SLICE], childParcelIds: [`${BASE}#c-road-1`] }
        });
        expect(verdict.flat).toBe(false);
        expect(verdict.violations.map(v => v.code)).toContain('formation-on-formed-ground');
    });

    it('rejects a nested parcel id outright', () => {
        const verdict = fd.conformanceOf({ goal: 'road-track', roadProposal: { childParcelIds: [NESTED] } });
        expect(verdict.violations.map(v => v.code)).toContain('parcel-id-too-deep');
    });

    it('accepts a forming GOAL that mints nothing — a park on a plot shaped for it is content', () => {
        const record = { goal: 'park', parentParcelIds: [SLICE], structureProposal: { parentParcelIds: [SLICE] } };
        expect(fd.conformanceOf(record).flat).toBe(true);
    });

    it('honours an explicit mintsGround prediction over the record\'s current children', () => {
        const record = { goal: 'park', parentParcelIds: [SLICE], structureProposal: { parentParcelIds: [SLICE] } };
        expect(fd.conformanceOf(record, { mintsGround: true }).flat).toBe(false);
        const minted = { goal: 'park', parentParcelIds: [SLICE], structureProposal: { childParcelIds: [`${BASE}#c-p-1`] } };
        expect(fd.conformanceOf(minted, { mintsGround: false }).flat).toBe(true);
    });
});

describe('flattening for publish', () => {
    it('projects a formation\'s declared parents to their base ids, deduped', () => {
        const flat = fd.flattenedParentsFor({
            goal: 'road-track',
            parentParcelIds: [SLICE, `${BASE}#p-upu-borovje-parcelacija-19`, 'HR-335550-1804/1'],
            roadProposal: { childParcelIds: [`${BASE}#c-road-1`] }
        });
        expect(flat).toEqual([BASE, 'HR-335550-1804/1']);
    });

    it('leaves content alone — its plot is the level that must survive', () => {
        expect(fd.flattenedParentsFor({ goal: 'urban-rule', parentParcelIds: [SLICE] })).toBe(null);
    });

    it('prefers geometric base ids over id parsing — a comasation mints every slice against one root', () => {
        const flat = fd.flattenedParentsFor({
            goal: 'road-track',
            parentParcelIds: [SLICE],
            roadProposal: { childParcelIds: [`${BASE}#c-road-1`] }
        }, { geometricBaseIds: ['HR-335550-1813/3', 'HR-335550-1908/1', 'HR-335550-1813/3'] });
        expect(flat).toEqual(['HR-335550-1813/3', 'HR-335550-1908/1']);
    });

    it('returns null when a formation already declares base ground', () => {
        expect(fd.flattenedParentsFor({
            goal: 'road-track', parentParcelIds: [BASE], roadProposal: { childParcelIds: [`${BASE}#c-r-1`] }
        })).toBe(null);
    });
});

describe('scanRecords', () => {
    it('summarises offenders by code and leaves conformant records out', () => {
        const scan = fd.scanRecords([
            { proposalId: 'ok-road', goal: 'road-track', parentParcelIds: [BASE], roadProposal: { childParcelIds: [`${BASE}#c-a-1`] } },
            { proposalId: 'bad-road', goal: 'road-track', parentParcelIds: [SLICE], roadProposal: { childParcelIds: [`${BASE}#c-b-1`] } },
            { proposalId: 'deep', goal: 'park', structureProposal: { childParcelIds: [NESTED] } }
        ]);
        expect(scan.total).toBe(3);
        expect(scan.offending).toBe(2);
        expect(scan.byCode['formation-on-formed-ground']).toBe(1);
        expect(scan.byCode['parcel-id-too-deep']).toBe(1);
        expect(scan.records.map(r => r.proposalId)).toEqual(['bad-road', 'deep']);
    });
});

describe('preparePublishRecord (the §15a publish gate)', () => {
    const BASE = 'HR-339270-823/1';
    const SLICE = `${BASE}#p-road-2`;

    it('flattens a formation onto its base ids and passes the gate', () => {
        const gate = fd.preparePublishRecord({
            goal: 'road-track',
            parentParcelIds: [SLICE, 'HR-339270-824'],
            roadProposal: { parentParcelIds: [SLICE], childParcelIds: [`${BASE}#c-me-1`] }
        }, { geometricBaseIds: [BASE, 'HR-339270-824'] });

        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal.parentParcelIds).toEqual([BASE, 'HR-339270-824']);
        expect(gate.proposal.roadProposal.parentParcelIds).toEqual([BASE, 'HR-339270-824']);
    });

    it('lets content keep its plot — the plot IS the third level', () => {
        const record = {
            goal: 'park',
            parentParcelIds: [SLICE],
            structureProposal: { parentParcelIds: [SLICE] }
        };
        const gate = fd.preparePublishRecord(record, {});
        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal.parentParcelIds).toEqual([SLICE]); // untouched
    });

    it('refuses a record that cannot be made flat, loudly not silently', () => {
        const nested = `${BASE}#a-1#b-2`;
        const gate = fd.preparePublishRecord({
            goal: 'road-track',
            parentParcelIds: [nested],
            roadProposal: { childParcelIds: [nested] }
        }, {});
        expect(gate.verdict.flat).toBe(false);
        expect(gate.verdict.violations.some(v => v.code === 'parcel-id-too-deep')).toBe(true);
    });

    it('is idempotent — a flat record passes unchanged', () => {
        const record = { goal: 'road-track', parentParcelIds: [BASE], roadProposal: { childParcelIds: [`${BASE}#c-me-1`] } };
        const gate = fd.preparePublishRecord(record, { geometricBaseIds: [BASE] });
        expect(gate.verdict.flat).toBe(true);
        expect(gate.proposal.parentParcelIds).toEqual([BASE]);
    });
});

describe('stripDerivedRecordData', () => {
    it('strips children, formations and scan results; keeps definitions and consent', () => {
        const record = {
            proposalId: 'c-x', goal: 'park',
            parentParcelIds: ['HR-1', 'HR-2'],
            cadastreParcelIds: ['HR-1', 'HR-2'],
            childParcelIds: ['HR-1#c-x-1'],
            descendantParcelIds: ['HR-1#c-x-1'],
            ownerAcceptances: { 'HR-1': { accepted: true } },
            structureProposal: {
                kind: 'park', geometry: { type: 'Polygon', coordinates: [] },
                parentParcelIds: ['HR-1'],
                formation: { mode: 'merge', parcelIds: ['HR-1'], childParcelIds: ['HR-1#c-x-1'] },
                demolishedBuildings: [{ id: 1 }], demolitionScanned: true
            },
            roadProposal: {
                definition: { width: 10, points: [], demolishedBuildings: [{ id: 2 }] },
                parentParcelIds: ['HR-2'], childParcelIds: ['HR-2#c-x-1'], childFeatures: [{}],
                parentsToRemove: ['HR-2']
            }
        };
        const out = fd.stripDerivedRecordData(record);
        expect(out.childParcelIds).toBeUndefined();
        expect(out.descendantParcelIds).toBeUndefined();
        expect(out.structureProposal.formation).toBeUndefined();
        expect(out.structureProposal.demolishedBuildings).toBeUndefined();
        expect(out.structureProposal.demolitionScanned).toBeUndefined();
        expect(out.roadProposal.childParcelIds).toBeUndefined();
        expect(out.roadProposal.childFeatures).toBeUndefined();
        expect(out.roadProposal.parentsToRemove).toBeUndefined();
        // Authored content and consent survive.
        expect(out.parentParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(out.cadastreParcelIds).toEqual(['HR-1', 'HR-2']);
        expect(out.ownerAcceptances).toEqual({ 'HR-1': { accepted: true } });
        expect(out.structureProposal.geometry).toBeTruthy();
        expect(out.roadProposal.definition.demolishedBuildings).toEqual([{ id: 2 }]);
        // The input record is untouched (publish must not mutate the local copy).
        expect(record.childParcelIds).toEqual(['HR-1#c-x-1']);
        expect(record.structureProposal.formation).toBeTruthy();
    });

    it("keeps a government-plan road's child features — they ARE the authored plan", () => {
        const record = {
            roadProposal: {
                definition: { kind: 'government_plan' },
                childFeatures: [{ id: 'f1' }], childParcelIds: ['HR-1#gov-1']
            }
        };
        const out = fd.stripDerivedRecordData(record);
        expect(out.roadProposal.childFeatures).toEqual([{ id: 'f1' }]);
        expect(out.roadProposal.childParcelIds).toBeUndefined();
    });

    it('publish gate applies the strip after verifying', () => {
        const gate = fd.preparePublishRecord({
            goal: 'park', parentParcelIds: ['HR-1'],
            childParcelIds: ['HR-1#c-x-1'],
            structureProposal: { kind: 'park', parentParcelIds: ['HR-1'], formation: { mode: 'adopt', parcelIds: ['HR-1'] } }
        }, {});
        expect(gate.proposal.childParcelIds).toBeUndefined();
        expect(gate.proposal.structureProposal.formation).toBeUndefined();
    });
});
