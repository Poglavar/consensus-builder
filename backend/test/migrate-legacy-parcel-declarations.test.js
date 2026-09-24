// Classifier/transform contract of scripts/migrate-legacy-parcel-declarations.mjs: which stored rows
// may be migrated, which are refused, and proof that a migration is exactly reversible.
import { describe, expect, it } from 'vitest';
import { isDeepStrictEqual } from 'node:util';
import {
    MIGRATION_ID,
    WRITABLE_COLUMNS,
    classifyLegacyRow,
    hasRecordedConsent,
    parseArgs,
    restoreLegacyParcelDeclarations
} from '../scripts/migrate-legacy-parcel-declarations.mjs';
import { assertCanonicalProposalRow, serializeProposalRow } from '../proposals/serializer.js';

const roster = (parcelId, extra = {}) => ({
    owners: { [`parcel:${parcelId}:owner:x`]: { key: `parcel:${parcelId}:owner:x`, displayName: 'X', shareText: '100%' } },
    acceptedBy: {},
    ownerOrder: [`parcel:${parcelId}:owner:x`],
    acceptedOwnerKeys: [],
    ...extra
});

// Shape of prod row #56 (a 2026-07 park): every declaration names the column's set, and the owner
// roster is keyed by a browser-generated piece id with nobody having accepted.
function legacyPark(overrides = {}) {
    const ids = ['HR-335649-371/1'];
    const acceptances = {
        'HR-335649-371/1#p-4gfqa0cv0u-5': roster('HR-335649-371/1#p-4gfqa0cv0u-5')
    };
    return {
        id: 56,
        cadastre_parcel_ids: ids.slice(),
        ancestor_parcel_ids: ids.slice(),
        accepted_parcel_ids: null,
        ownership_flow: null,
        owner_acceptances: JSON.parse(JSON.stringify(acceptances)),
        road_proposal: null,
        building_proposal: null,
        reparcellization: null,
        structure_proposal: { kind: 'park', parentParcelIds: ids.slice() },
        proposal_data: {
            title: 'Park 1307-1306',
            parentParcelIds: ids.slice(),
            structureProposal: { kind: 'park', parentParcelIds: ids.slice() },
            ownerAcceptances: JSON.parse(JSON.stringify(acceptances))
        },
        ...overrides
    };
}

const applyUpdates = (row, result) => ({ ...row, ...result.updates });

describe('migrate-legacy-parcel-declarations classifier', () => {
    it('migrates a row whose retired declarations equal cadastre_parcel_ids, and the API can then read it', () => {
        const row = legacyPark();
        expect(() => assertCanonicalProposalRow(row)).toThrow();

        const result = classifyLegacyRow(row, { now: '2026-09-24T00:00:00.000Z' });
        expect(result.class).toBe('migratable');
        const migrated = applyUpdates(row, result);

        expect(migrated.cadastre_parcel_ids).toEqual(row.cadastre_parcel_ids);
        expect(migrated.ancestor_parcel_ids).toBeNull();
        expect(migrated.proposal_data.parentParcelIds).toBeUndefined();
        expect(migrated.structure_proposal.parentParcelIds).toBeUndefined();
        expect(migrated.structure_proposal.kind).toBe('park');
        expect(migrated.owner_acceptances).toEqual({});
        expect(migrated.proposal_data.cadastreParcelIds).toEqual(['HR-335649-371/1']);

        const provenance = migrated.proposal_data.legacy[MIGRATION_ID];
        expect(provenance.migratedAt).toBe('2026-09-24T00:00:00.000Z');
        expect(provenance.removed.map(field => [field.container, field.path.join('.')])).toEqual(expect.arrayContaining([
            ['proposal_data', 'parentParcelIds'],
            ['proposal_data', 'structureProposal.parentParcelIds'],
            ['structure_proposal', 'parentParcelIds'],
            ['ancestor_parcel_ids', ''],
            ['owner_acceptances', 'HR-335649-371/1#p-4gfqa0cv0u-5'],
            ['proposal_data', 'ownerAcceptances.HR-335649-371/1#p-4gfqa0cv0u-5']
        ]));

        expect(() => assertCanonicalProposalRow(migrated)).not.toThrow();
        const served = serializeProposalRow(migrated);
        expect(served.cadastreParcelIds).toEqual(['HR-335649-371/1']);
        expect(served).not.toHaveProperty('legacy');
    });

    it('is exactly reversible from the provenance block alone', () => {
        const row = legacyPark();
        const migrated = applyUpdates(row, classifyLegacyRow(row));
        const restored = restoreLegacyParcelDeclarations(migrated);
        WRITABLE_COLUMNS.forEach(column => {
            expect(isDeepStrictEqual(restored[column] ?? null, row[column] ?? null), column).toBe(true);
        });
    });

    it('is idempotent: a migrated row is canonical and yields no further updates', () => {
        const row = legacyPark();
        const migrated = applyUpdates(row, classifyLegacyRow(row));
        expect(classifyLegacyRow(migrated).class).toBe('canonical');
    });

    it('archives retired building bookkeeping and reparcellization owner-share piece ids', () => {
        const ids = ['HR-1-1', 'HR-1-2'];
        const row = legacyPark({
            owner_acceptances: null,
            structure_proposal: null,
            building_proposal: {
                parentParcelIds: ids.slice(),
                parentParcelNumbers: [{ id: 'HR-1-1', number: '1' }],
                ancestorKey: 'HR-1-1|HR-1-2',
                ineligibleParcels: [{ parcelId: 'HR-1-2#p-a-1', reason: 'too small' }]
            },
            reparcellization: {
                parentParcelIds: ids.slice(),
                parcelIds: ids.slice(),
                ownerShares: [{ ownerKey: 'lot-1', percent: 1, parcelIds: ['HR-1-1#p-b-1'] }]
            },
            cadastre_parcel_ids: ids.slice(),
            ancestor_parcel_ids: ids.slice(),
            proposal_data: { title: 'Block', parentParcelIds: ids.slice() }
        });
        const result = classifyLegacyRow(row);
        expect(result.class).toBe('migratable');
        const migrated = applyUpdates(row, result);
        expect(migrated.building_proposal).toEqual({ ineligibleParcels: [{ reason: 'too small' }] });
        expect(migrated.reparcellization).toEqual({ ownerShares: [{ ownerKey: 'lot-1', percent: 1 }] });
        const restored = restoreLegacyParcelDeclarations(migrated);
        expect(restored.building_proposal).toEqual(row.building_proposal);
        expect(restored.reparcellization).toEqual(row.reparcellization);
    });

    it('refuses a row whose legacy selection is narrower than cadastre_parcel_ids (the 60 prod rows)', () => {
        const row = legacyPark({
            cadastre_parcel_ids: ['HR-335550-1791/69', 'HR-335550-1791/25'],
            ancestor_parcel_ids: ['HR-335550-1791/69', 'HR-335550-1791/25'],
            proposal_data: { title: 'UPU Borovje', parentParcelIds: ['HR-335550-1791/25'] },
            structure_proposal: { kind: 'park', parentParcelIds: ['HR-335550-1791/25'] },
            owner_acceptances: null
        });
        const result = classifyLegacyRow(row);
        expect(result.class).toBe('ambiguous');
        expect(result.updates).toBeUndefined();
        expect(result.reasons).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: 'legacy-declaration-disagrees', relation: 'subset', path: 'proposal_data.parentParcelIds' })
        ]));
    });

    it('refuses to drop an out-of-set acceptance that records consent', () => {
        const pieceId = 'HR-335649-371/1#p-4gfqa0cv0u-5';
        const consented = roster(pieceId, { acceptedOwnerKeys: [`parcel:${pieceId}:owner:x`] });
        const row = legacyPark({
            owner_acceptances: { [pieceId]: consented },
            proposal_data: { title: 'Park', parentParcelIds: ['HR-335649-371/1'], ownerAcceptances: { [pieceId]: consented } }
        });
        const result = classifyLegacyRow(row);
        expect(result.class).toBe('ambiguous');
        expect(result.reasons.map(reason => reason.code)).toContain('consent-outside-declaration');
    });

    it('treats unknown acceptance shapes as possible consent', () => {
        expect(hasRecordedConsent(roster('HR-1-1'))).toBe(false);
        expect(hasRecordedConsent(roster('HR-1-1', { acceptedBy: { 'owner:x': '2026-01-01' } }))).toBe(true);
        expect(hasRecordedConsent('yes')).toBe(true);
        expect(hasRecordedConsent({ owners: {}, acceptedOwnerKeys: 'x' })).toBe(true);
    });

    it('refuses generated ids in a legacy declaration, accepted ids outside the set, and unknown parcels', () => {
        const generated = legacyPark({ proposal_data: { parentParcelIds: ['HR-335649-371/1#p-a-1'] }, owner_acceptances: null, structure_proposal: null });
        expect(classifyLegacyRow(generated).reasons.map(reason => reason.code)).toContain('legacy-declaration-generated-ids');

        const accepted = legacyPark({ accepted_parcel_ids: ['HR-9-9'] });
        expect(classifyLegacyRow(accepted).reasons.map(reason => reason.code)).toContain('acceptance-outside-declaration');

        const synthetic = classifyLegacyRow(legacyPark(), { parcelExists: () => false });
        expect(synthetic.class).toBe('ambiguous');
        expect(synthetic.reasons[0]).toMatchObject({ code: 'declared-parcel-unknown', ids: ['HR-335649-371/1'] });
    });

    it('classifies a row with no valid cadastre_parcel_ids as unrecoverable', () => {
        expect(classifyLegacyRow(legacyPark({ cadastre_parcel_ids: null })).class).toBe('unrecoverable');
        expect(classifyLegacyRow(legacyPark({ cadastre_parcel_ids: ['HR-1-1#p-x-1'] })).class).toBe('unrecoverable');
    });

    it('leaves already-readable rows alone', () => {
        const row = { id: 1, cadastre_parcel_ids: ['HR-1-1'], proposal_data: { cadastreParcelIds: ['HR-1-1'] } };
        expect(classifyLegacyRow(row)).toMatchObject({ class: 'canonical' });
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
