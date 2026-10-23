// Unit tests for frontend/js/design-record.js: the design/v1 object a local design record publishes as
// (exactly its authored fields and one payload, without apply-time state, cadastre ids, terms or
// server ids), the stability of its CID across applying it, and the check a receiver runs on one.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const DesignRecord = require('../../frontend/js/design-record.js');
const Cid = require('../../frontend/js/cid.js');

const square = (x, y, size = 0.001) => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
});
const SITE = square(15.96, 45.8);
const ORIGIN = Cid.cidOfObject({ schema: 'design/v1', title: 'the source' });
const FIELDS = ['schema', 'goal', 'title', 'description', 'author', 'city', 'site', 'toleranceM', 'geometry', 'origin', 'authoredAt'];
const thrownCode = fn => { try { fn(); } catch (error) { return error.code; } return null; };

// A park as the browser stores it after drawing, publishing and applying it.
function park() {
    return {
        proposalId: 'park-7', goal: 'park', title: '  Pocket park ', description: '', name: 'Pocket park',
        author: 'Ana', city: 'zagreb', site: SITE, toleranceM: 0.5, geometry: square(15.9602, 45.8002, 0.0005),
        origin: { cid: ORIGIN, title: 'display only' },
        createdAt: '2026-10-21T10:00:00Z', updatedAt: '2026-10-21T11:30:00.000Z',
        structureProposal: { kind: 'park', geometry: square(15.9602, 45.8002, 0.0005), trees: 12 },
        cadastreParcelIds: ['k9', 'k10'], acceptedParcelIds: ['k9'], ownerAcceptances: { k9: {} },
        published: { cid: ORIGIN, publishedAt: '2026-10-21T10:05:00.000Z', apiBase: 'https://api.example.test' },
        serverProposalId: '41', lifecycleStatus: 'Active', kind: 'owner-deal', offer: 1000, offerCurrency: 'EUR',
        approvalConfig: { schema: 'proposal-approval/v1', rights: null, policy: { type: 'unanimous' } }, lens: ['member-1'],
        screenshotUrl: 'https://example.test/park.png', applied: false
    };
}

// The same park after one browser applied it: the flags, the materialization, the demolition scan,
// the generated furniture and the local payload hash.
function applied(record) {
    const copy = JSON.parse(JSON.stringify(record));
    Object.assign(copy, { applied: true, appliedAt: '2026-10-21T12:00:00.000Z', status: 'applied', childParcelIds: ['park-7#1'],
        descendantParcelIds: ['park-7#1'], childFeatures: [{ type: 'Feature' }], parentFeatures: [{ type: 'Feature' }] });
    Object.assign(copy.structureProposal, {
        applied: true, appliedAt: '2026-10-21T12:00:00.000Z', status: 'applied', childParcelIds: ['park-7#1'],
        parentFeatures: [{ type: 'Feature' }], parentsToRemove: ['k9'], formation: { pieces: 1 }, childFeatures: [],
        demolishedBuildings: [{ objectId: 5 }], demolitionScanned: true, demolitionScanFailed: false,
        decorations: [{ kind: 'bench', at: [15.9603, 45.8003] }], hash: 'local-hash'
    });
    return copy;
}

describe('published', () => {
    it.each(['block', 'row', 'parcelBased', 'single'])('publishes the authored surroundings of a %s building with its CID', typologyType => {
        const record = {
            goal: 'buildings', site: SITE,
            geometry: { buildings: [], groundSurface: { treatment: 'green', polygon: SITE, decorationDesign: { version: 3, trees: [{ coordinate: [15.9602, 45.8002], kind: 'broadleaf', heightM: 10 }] } } },
            buildingProposal: { typologyType }
        };
        const published = DesignRecord.published(record);
        expect(published.geometry.groundSurface).toEqual(record.geometry.groundSurface);
        expect(DesignRecord.validate(published).valid).toBe(true);
        const before = DesignRecord.cidOf(record);
        record.geometry.groundSurface.treatment = 'paved';
        expect(DesignRecord.cidOf(record)).not.toBe(before);
        expect(published.geometry.groundSurface.treatment).toBe('green');
    });

    it.each(['park', 'square'])('publishes authored %s furniture while keeping generated furniture out of its CID', kind => {
        const record = park();
        record.goal = kind;
        record.structureProposal.kind = kind;
        const design = { version: kind === 'park' ? 3 : 2, benches: [{ coordinate: [15.9602, 45.8002], bearing: 30 }] };
        record.structureProposal.decorationDesign = design;
        const before = DesignRecord.cidOf(record);
        const afterApply = applied(record);
        expect(DesignRecord.cidOf(afterApply)).toBe(before);
        const published = DesignRecord.published(afterApply);
        expect(published.structureProposal.decorationDesign).toEqual(design);
        expect(published.structureProposal.decorations).toBeUndefined();
        record.structureProposal.decorationDesign.benches[0].bearing = 60;
        expect(DesignRecord.cidOf(record)).not.toBe(before);
    });

    it('keeps exactly the authored fields and the one payload', () => {
        const design = DesignRecord.published(park());
        expect(Object.keys(design).sort()).toEqual([...FIELDS, 'structureProposal'].sort());
        expect(design).toEqual({
            schema: 'design/v1', goal: 'park', title: 'Pocket park', description: null, author: 'Ana', city: 'zagreb',
            site: SITE, toleranceM: 0.5, geometry: square(15.9602, 45.8002, 0.0005), origin: { cid: ORIGIN },
            authoredAt: '2026-10-21T10:00:00.000Z',
            structureProposal: { kind: 'park', geometry: square(15.9602, 45.8002, 0.0005), trees: 12 }
        });
    });

    it('leaves cadastre ids, terms, kind, approval, lens, lifecycle, server ids and thumbnails out of the bytes', () => {
        const text = new TextDecoder().decode(Cid.canonicalBytes(DesignRecord.published(park())));
        ['cadastreParcelIds', 'k10', 'acceptedParcelIds', 'ownerAcceptances', 'published', 'serverProposalId', 'lifecycleStatus',
            'owner-deal', 'offer', 'approvalConfig', 'lens', 'screenshotUrl', 'proposalId', 'updatedAt', 'applied', 'display only']
            .forEach(word => expect(text, word).not.toContain(word));
    });

    it('strips what applying writes back into the payload', () => {
        const design = DesignRecord.published(applied(park()));
        expect(design.structureProposal).toEqual({ kind: 'park', geometry: square(15.9602, 45.8002, 0.0005), trees: 12 });
        const road = DesignRecord.published({
            goal: 'road', site: SITE, createdAt: '2026-10-21T10:00:00Z',
            roadProposal: { applied: true, childParcelIds: ['r#1'], hash: 'x', decorations: [],
                definition: { widthM: 12, surfaceFootprint: SITE, demolishedBuildings: [{ objectId: 1 }], demolitionScanFailed: true } }
        });
        expect(road.roadProposal).toEqual({ definition: { widthM: 12 } });
        const building = DesignRecord.published({ goal: 'single', site: SITE,
            buildingProposal: { floors: 4, demolishedBuildings: [1], demolitionScanned: true, demolitionScanFailed: true } });
        expect(building.buildingProposal).toEqual({ floors: 4 });
    });

    it('trims text, drops a tolerance that is not positive and an origin without a CID, and never edits its input', () => {
        const record = park();
        const before = JSON.stringify(record);
        Object.assign(record, { title: ' ', author: 7, toleranceM: -1, origin: { relation: 'fork' }, createdAt: 'later' });
        const design = DesignRecord.published(record);
        expect(design).toMatchObject({ title: null, author: null, toleranceM: null, origin: null, authoredAt: null });
        const untouched = park();
        DesignRecord.published(applied(untouched));
        expect(JSON.stringify(untouched)).toBe(before);
        expect(() => DesignRecord.published(null)).toThrow(TypeError);
    });
});

describe('cidOf', () => {
    it('keeps a published OSM street identity when the store decodes it for drawing', () => {
        const form = require('../../frontend/js/corridor-osm-form.js');
        const depth = require('../../frontend/js/proposals/formation-depth.js');
        const street = { ...park(), goal: 'road-track', structureProposal: undefined,
            roadProposal: { definition: form.toRecord({
                segments: [[{ lat: 52.48, lng: -1.88 }, { lat: 52.481, lng: -1.88 }]],
                segmentIds: ['intent-street'], width: 7.5,
                profile: { strips: [{ type: 'sidewalk', width: 1.5 }, { type: 'driving', width: 2.25, direction: 'forward' }, { type: 'driving', width: 2.25, direction: 'backward' }, { type: 'sidewalk', width: 1.5 }] }
            }) }
        };
        const expected = DesignRecord.cidOf(street);
        const drawing = depth.decodeRoadView(street);
        expect(drawing.roadProposal.definition.osm).toBeUndefined();
        expect(drawing.roadProposal.definition.segments).toHaveLength(1);
        expect(DesignRecord.cidOf(drawing)).toBe(expected);
        expect(DesignRecord.published(drawing)).toEqual(DesignRecord.published(street));
        drawing.roadProposal.definition.segments[0][1].lat += 0.001;
        expect(DesignRecord.cidOf(drawing)).not.toBe(expected);
    });

    it('is the CID of the published object, the same before and after applying', () => {
        const cid = DesignRecord.cidOf(park());
        expect(cid).toBe(Cid.cidOfObject(DesignRecord.published(park())));
        expect(Cid.isCid(cid)).toBe(true);
        expect(DesignRecord.cidOf(applied(park()))).toBe(cid);
        const relabelled = { ...park(), cadastreParcelIds: ['k1'], serverProposalId: '99', published: null, proposalId: 'park-8' };
        expect(DesignRecord.cidOf(relabelled)).toBe(cid);
    });

    it('moves with every authored change', () => {
        const cid = DesignRecord.cidOf(park());
        const edits = [
            record => { record.title = 'Bigger park'; },
            record => { record.description = 'With a fountain'; },
            record => { record.site = square(15.96, 45.8, 0.002); },
            record => { record.structureProposal.trees = 13; },
            record => { record.toleranceM = 1; },
            record => { record.origin = null; },
            record => { record.createdAt = '2026-10-22T10:00:00Z'; },
            record => { record.goal = 'square'; }
        ];
        edits.forEach(edit => {
            const record = park();
            edit(record);
            expect(DesignRecord.cidOf(record), edit.toString()).not.toBe(cid);
        });
    });

    it('refuses a record holding a value that is not JSON', () => {
        const record = park();
        record.structureProposal.geometry.coordinates[0][1][0] = NaN;
        expect(thrownCode(() => DesignRecord.cidOf(record))).toBe('invalid-cid-input');
        const dated = park();
        dated.structureProposal.plantedOn = new Date(0);
        expect(thrownCode(() => DesignRecord.cidOf(dated))).toBe('invalid-cid-input');
    });
});

describe('validate', () => {
    const valid = () => DesignRecord.published(park());
    const codes = object => DesignRecord.validate(object).errors.map(error => error.code);

    it('accepts a published design', () => {
        expect(DesignRecord.validate(valid())).toEqual({ valid: true, errors: [] });
        expect(DesignRecord.validate({ ...valid(), origin: null, site: null })).toEqual({ valid: true, errors: [] });
    });

    it.each(['road', 'track'])('accepts a %s whose only land is its authored corridor polygon', kind => {
        const { structureProposal, ...content } = valid();
        const design = { ...content, goal: 'road-track', site: null, geometry: null,
            roadProposal: { definition: { transportMode: kind, polygon: SITE,
                points: [{ lat: 45.8, lng: 15.96 }, { lat: 45.801, lng: 15.961 }], width: 7 } } };
        expect(DesignRecord.validate(design)).toEqual({ valid: true, errors: [] });
        delete design.roadProposal.definition.polygon;
        expect(codes(design)).toContain('design-shape');
    });

    it('counts the exact canonical UTF-8 bytes for publication', () => {
        const record = { goal: 'single', title: 'Courtyard č', buildingProposal: {}, site: SITE };
        expect(DesignRecord.publicationSize(record)).toBe(Cid.canonicalBytes(DesignRecord.published(record)).length);
    });

    it('names each problem by its code and field', () => {
        expect(codes(null)).toEqual(['design-schema']);
        expect(codes({ ...valid(), schema: 'proposal/v1' })).toEqual(['design-schema']);
        const missing = valid();
        delete missing.authoredAt;
        expect(DesignRecord.validate(missing).errors).toEqual([expect.objectContaining({ code: 'design-field-missing', field: 'authoredAt' })]);
        expect(DesignRecord.validate({ ...valid(), cadastreParcelIds: ['k9'] }).errors)
            .toEqual([expect.objectContaining({ code: 'design-field-unknown', field: 'cadastreParcelIds' })]);
        expect(codes({ ...valid(), goal: ' ' })).toEqual(['design-goal']);
        expect(codes({ ...valid(), title: 5 })).toEqual(['design-field-invalid']);
        expect(codes({ ...valid(), toleranceM: 0 })).toEqual(['design-field-invalid']);
        expect(codes({ ...valid(), authoredAt: '2026-10-21' })).toEqual(['design-field-invalid']);
        expect(codes({ ...valid(), site: { type: 'Point', coordinates: [15.96, 45.8] } })).toEqual(['design-field-invalid']);
        expect(codes({ ...valid(), geometry: 'square' })).toEqual(['design-field-invalid']);
        expect(codes({ ...valid(), site: null, geometry: null, structureProposal: {} })).toEqual(['design-shape']);
        expect(codes({ ...valid(), origin: { cid: 'c2-abc' } })).toEqual(['design-origin']);
        expect(codes({ ...valid(), origin: { cid: ORIGIN, title: 'extra' } })).toEqual(['design-origin']);
    });

    it('needs exactly one payload, and an object', () => {
        const none = valid();
        delete none.structureProposal;
        expect(codes(none)).toEqual(['design-payload']);
        expect(codes({ ...valid(), roadProposal: { definition: {} } })).toEqual(['design-payload']);
        expect(codes({ ...valid(), structureProposal: [1] })).toEqual(['design-payload']);
    });
});
