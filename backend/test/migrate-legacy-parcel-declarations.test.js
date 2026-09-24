// Classifier/transform contract of scripts/migrate-legacy-parcel-declarations.mjs under the
// geometry-supported-declaration rule: which rows are re-declared, which are refused, what is
// archived, and proof that a migration is exactly reversible.
import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import {
    MIGRATION_ID,
    MIGRATION_RULE,
    WRITABLE_COLUMNS,
    classifyLegacyRow,
    geometrySupportedDeclaration,
    hasRecordedConsent,
    parseArgs,
    restoreLegacyParcelDeclarations
} from '../scripts/migrate-legacy-parcel-declarations.mjs';
import { assertCanonicalProposalRow, serializeProposalRow } from '../proposals/serializer.js';

const box = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] });
const snapshot = (parcelId, extra = {}) => ({
    owners: { [`parcel:${parcelId}:owner:x`]: { key: `parcel:${parcelId}:owner:x`, displayName: 'X', shareText: '100%' } },
    acceptedBy: {},
    ownerOrder: [`parcel:${parcelId}:owner:x`],
    acceptedOwnerKeys: [],
    ...extra
});

// Shape of prod row #64 (UPU Borovje building): the legacy "selection" 1791/25 is only the id prefix
// of the readjustment piece; the building actually stands on 1791/69, which the July backfill put in
// the column next to the prefix.
function borovjeBuilding(overrides = {}) {
    const column = ['HR-335550-1791/69', 'HR-335550-1791/25'];
    const piece = 'HR-335550-1791/25#p-upu-borovje-parcelacija-20';
    return {
        id: 64,
        type: 'building',
        cadastre_parcel_ids: column.slice(),
        ancestor_parcel_ids: column.slice(),
        accepted_parcel_ids: null,
        ownership_flow: null,
        owner_acceptances: { [piece]: snapshot(piece) },
        road_proposal: null,
        structure_proposal: null,
        reparcellization: null,
        building_proposal: { parentParcelIds: ['HR-335550-1791/25'], ancestorKey: 'HR-335550-1791/25', typologyType: 'single' },
        proposal_data: {
            title: 'UPU Borovje – zgrada M1-11',
            parentParcelIds: ['HR-335550-1791/25'],
            buildingProposal: { parentParcelIds: ['HR-335550-1791/25'], ancestorKey: 'HR-335550-1791/25', typologyType: 'single' },
            geometry: { buildings: [{ type: 'Feature', properties: {}, geometry: box(16.0, 45.8, 16.0005, 45.8003) }] },
            ownerAcceptances: { [piece]: snapshot(piece) }
        },
        ...overrides
    };
}
// 1791/25 only touches the building; 1791/69 carries it; 1813/8 is a real spill the backfill missed.
const OVERLAPS = [
    { id: 'HR-335550-1791/69', parcelAreaM2: 58226, overlapM2: 2310.3 },
    { id: 'HR-335550-1813/8', parcelAreaM2: 900, overlapM2: 14.2 },
    { id: 'HR-335550-1791/25', parcelAreaM2: 1092, overlapM2: 0 },
    { id: 'HR-335550-1791/30', parcelAreaM2: 929, overlapM2: 0.4 }
];
const applyUpdates = (row, result) => ({ ...row, ...result.updates });

describe('geometrySupportedDeclaration', () => {
    it('keeps covered declared parcels in order, adds covered ones by overlap, drops the rest', () => {
        expect(geometrySupportedDeclaration(['HR-a', 'HR-b', 'HR-c'], [
            { id: 'HR-c', overlapM2: 5 },
            { id: 'HR-d', overlapM2: 2 },
            { id: 'HR-e', overlapM2: 40 },
            { id: 'HR-a', overlapM2: 0.99 }
        ])).toEqual({ ids: ['HR-c', 'HR-e', 'HR-d'], kept: ['HR-c'], added: ['HR-e', 'HR-d'], dropped: ['HR-a', 'HR-b'] });
    });
});

describe('migrate-legacy-parcel-declarations classifier', () => {
    it('re-declares a row as the parcels its geometry covers (drop + add), and the API can then read it', () => {
        const row = borovjeBuilding();
        expect(() => assertCanonicalProposalRow(row)).toThrow();

        const result = classifyLegacyRow(row, { overlaps: OVERLAPS, now: '2026-09-24T00:00:00.000Z' });
        expect(result.class).toBe('migratable');
        const migrated = applyUpdates(row, result);

        expect(migrated.cadastre_parcel_ids).toEqual(['HR-335550-1791/69', 'HR-335550-1813/8']);
        expect(migrated.proposal_data.cadastreParcelIds).toEqual(migrated.cadastre_parcel_ids);
        expect(migrated.ancestor_parcel_ids).toBeNull();
        expect(migrated.proposal_data.parentParcelIds).toBeUndefined();
        expect(migrated.building_proposal).toEqual({ typologyType: 'single' });
        expect(migrated.owner_acceptances).toEqual({});

        const provenance = migrated.proposal_data.legacy[MIGRATION_ID];
        expect(provenance).toMatchObject({
            rule: MIGRATION_RULE,
            migratedAt: '2026-09-24T00:00:00.000Z',
            approximateFootprint: false,
            footprintSources: ['geometry.buildings'],
            previousCadastreParcelIds: ['HR-335550-1791/69', 'HR-335550-1791/25'],
            addedParcelIds: ['HR-335550-1813/8'],
            droppedParcelIds: ['HR-335550-1791/25'],
            overlapM2: { 'HR-335550-1791/69': 2310.3, 'HR-335550-1813/8': 14.2, 'HR-335550-1791/25': 0 }
        });
        expect(provenance.sourceChecksum).toMatch(/^[0-9a-f]{64}$/);

        const served = serializeProposalRow(migrated);
        expect(served.cadastreParcelIds).toEqual(['HR-335550-1791/69', 'HR-335550-1813/8']);
        expect(served).not.toHaveProperty('legacy');
    });

    it('is exactly reversible from the provenance block alone', () => {
        const row = borovjeBuilding();
        const migrated = applyUpdates(row, classifyLegacyRow(row, { overlaps: OVERLAPS }));
        const restored = restoreLegacyParcelDeclarations(migrated);
        WRITABLE_COLUMNS.forEach(column => {
            expect(isDeepStrictEqual(restored[column] ?? null, row[column] ?? null), column).toBe(true);
        });
    });

    it('restores a pre-existing proposal_data.cadastreParcelIds exactly as well', () => {
        const row = borovjeBuilding();
        row.proposal_data.cadastreParcelIds = ['HR-335550-1791/25'];
        const migrated = applyUpdates(row, classifyLegacyRow(row, { overlaps: OVERLAPS }));
        expect(migrated.proposal_data.cadastreParcelIds).toEqual(['HR-335550-1791/69', 'HR-335550-1813/8']);
        expect(restoreLegacyParcelDeclarations(migrated).proposal_data).toEqual(row.proposal_data);
    });

    it('is idempotent: a migrated row is canonical afterwards', () => {
        const row = borovjeBuilding();
        const migrated = applyUpdates(row, classifyLegacyRow(row, { overlaps: OVERLAPS }));
        expect(classifyLegacyRow(migrated, { overlaps: OVERLAPS }).class).toBe('canonical');
    });

    it('marks a centreline-only road as an approximate footprint', () => {
        const row = borovjeBuilding({
            type: 'road',
            building_proposal: null,
            road_proposal: { definition: { width: 8, points: [{ lat: 45.8, lng: 16.0 }, { lat: 45.8003, lng: 16.0005 }] }, parentParcelIds: ['HR-335550-1791/25'] },
            proposal_data: { title: 'Road', parentParcelIds: ['HR-335550-1791/25'] },
            owner_acceptances: null
        });
        const result = classifyLegacyRow(row, { overlaps: OVERLAPS });
        expect(result.class).toBe('migratable');
        const provenance = applyUpdates(row, result).proposal_data.legacy[MIGRATION_ID];
        expect(provenance.approximateFootprint).toBe(true);
        expect(provenance.footprintSources[0]).toMatch(/centreline/);
    });

    it('refuses a row whose footprint cannot be rebuilt or covers no parcel by 1 m²', () => {
        const noGeometry = borovjeBuilding({ proposal_data: { title: 'x', parentParcelIds: ['HR-335550-1791/25'] } });
        expect(classifyLegacyRow(noGeometry, { overlaps: [] })).toMatchObject({
            class: 'refused', reasons: [expect.objectContaining({ code: 'footprint-unavailable' })]
        });
        const touchOnly = classifyLegacyRow(borovjeBuilding(), { overlaps: [{ id: 'HR-335550-1791/25', overlapM2: 0.3 }] });
        expect(touchOnly).toMatchObject({ class: 'refused', reasons: [expect.objectContaining({ code: 'geometry-covers-no-parcel' })] });
        expect(touchOnly.updates).toBeUndefined();
    });

    it('refuses to drop an ownership snapshot outside the new declaration that records consent', () => {
        const piece = 'HR-335550-1791/25#p-upu-borovje-parcelacija-20';
        const consented = snapshot(piece, { acceptedOwnerKeys: [`parcel:${piece}:owner:x`] });
        const row = borovjeBuilding({ owner_acceptances: { [piece]: consented } });
        const result = classifyLegacyRow(row, { overlaps: OVERLAPS });
        expect(result.class).toBe('refused');
        expect(result.reasons.map(reason => reason.code)).toContain('consent-outside-declaration');
    });

    it('refuses accepted parcels or ownership flow outside the new declaration', () => {
        const accepted = classifyLegacyRow(borovjeBuilding({ accepted_parcel_ids: ['HR-335550-1791/25'] }), { overlaps: OVERLAPS });
        expect(accepted.reasons.map(reason => reason.code)).toContain('acceptance-outside-declaration');
        const flow = classifyLegacyRow(borovjeBuilding({ ownership_flow: [{ parcelId: 'HR-9-9', cededM2: 1 }] }), { overlaps: OVERLAPS });
        expect(flow.reasons.map(reason => reason.code)).toContain('ownership-flow-outside-declaration');
    });

    it('treats unknown snapshot shapes as possible consent', () => {
        expect(hasRecordedConsent(snapshot('HR-1-1'))).toBe(false);
        expect(hasRecordedConsent(snapshot('HR-1-1', { acceptedBy: { 'owner:x': '2026-01-01' } }))).toBe(true);
        expect(hasRecordedConsent('yes')).toBe(true);
        expect(hasRecordedConsent({ owners: {}, acceptedOwnerKeys: 'x' })).toBe(true);
    });

    it('leaves already-readable rows alone', () => {
        const row = { id: 1, cadastre_parcel_ids: ['HR-1-1'], proposal_data: { cadastreParcelIds: ['HR-1-1'] } };
        expect(classifyLegacyRow(row, { overlaps: [] })).toMatchObject({ class: 'canonical' });
    });
});

describe('migrate-legacy-parcel-declarations CLI', () => {
    it('prints usage without a mode, and never combines dry-run with apply', () => {
        expect(parseArgs([]).help).toBe(true);
        expect(parseArgs(['--dry-run'])).toMatchObject({ dryRun: true, apply: false, help: false });
        expect(parseArgs(['--apply', '--ids', '20,22'])).toMatchObject({ apply: true, ids: [20, 22] });
        expect(() => parseArgs(['--apply', '--dry-run'])).toThrow(/either/);
        expect(() => parseArgs(['--ids', 'x'])).toThrow(/numeric/);
        expect(() => parseArgs(['--force'])).toThrow(/Unknown/);
    });
});
