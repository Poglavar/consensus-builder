// Seed scripts write proposal rows straight to the database; this locks that what they write is the
// current record shape the API serializer can read, never retired parcel declarations.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { canonicalSeedRecord } from '../scripts/lib/canonical-seed-record.mjs';
import { buildProposal, PARCEL_ID } from '../scripts/seed-lovinciceva-proposal.mjs';
import { assertCanonicalProposalRow } from '../proposals/serializer.js';

const requireCjs = createRequire(import.meta.url);
const authoredRecord = requireCjs('../../frontend/js/proposals/authored-record.js');

const square = (x, y, size) => ({
    type: 'Polygon',
    coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]]
});

function lovincicevaSeed() {
    const parcelFeature = { type: 'Feature', properties: {}, geometry: square(15.99, 45.8, 0.001) };
    const buildings = [
        { type: 'Feature', properties: { label: 'A', parcelId: `${PARCEL_ID}#p-a-1` }, geometry: square(15.9902, 45.8002, 0.0002) },
        { type: 'Feature', properties: { label: 'B' }, geometry: square(15.9906, 45.8006, 0.0002) }
    ];
    const stats = { parcelAreaM2: 6000, footprintAreaM2: 900, siteCoveragePercent: 15, aboveGroundGbpM2: 5400, kin: 0.9 };
    return buildProposal({ parcelFeature, buildings, stats });
}

const rowOf = record => ({
    cadastre_parcel_ids: record.cadastreParcelIds,
    proposal_data: record,
    building_proposal: record.buildingProposal ?? null
});

describe('seed proposal records', () => {
    it('a seed builder alone still produces retired declarations the API would refuse', () => {
        const raw = lovincicevaSeed();
        expect(authoredRecord.legacyCadastreDeclarations(raw).length).toBeGreaterThan(0);
        expect(() => assertCanonicalProposalRow(rowOf(raw))).toThrow();
    });

    it('canonicalSeedRecord writes the current shape: one declaration, no retired aliases, readable', () => {
        const record = canonicalSeedRecord(lovincicevaSeed());
        expect(record.cadastreParcelIds).toEqual([PARCEL_ID]);
        expect(authoredRecord.legacyCadastreDeclarations(record)).toEqual([]);
        expect(record).not.toHaveProperty('parentParcelIds');
        expect(record).not.toHaveProperty('parcelIds');
        expect(record.buildingProposal).not.toHaveProperty('parentParcelNumbers');
        expect(record.buildingProposal).not.toHaveProperty('ancestorKey');
        expect(record.geometry.buildings).toHaveLength(2);
        expect(record.geometry.buildings[0].properties).not.toHaveProperty('parcelId');
        expect(() => assertCanonicalProposalRow(rowOf(record))).not.toThrow();
    });

    it('refuses, before any write, a seed record the API could not read', () => {
        expect(() => canonicalSeedRecord({ proposalId: 'x', title: 'no land' }))
            .toThrow(/Seed proposal x would be unreadable: .*cadastre_parcel_ids is required/);
    });

    it('every seed script that inserts proposals goes through canonicalSeedRecord and writes no ancestor ids', () => {
        const dir = fileURLToPath(new URL('../scripts/', import.meta.url));
        const seeds = readdirSync(dir).filter(name => /^seed-.*\.mjs$/.test(name));
        const inserting = seeds.filter(name => /INSERT INTO (public\.)?proposal\s*\(/.test(readFileSync(dir + name, 'utf8')));
        expect(inserting.length).toBeGreaterThanOrEqual(9);
        inserting.forEach(name => {
            const source = readFileSync(dir + name, 'utf8');
            expect(source, name).toMatch(/const proposal = canonicalSeedRecord\(authored\);/);
            expect(source, name).not.toMatch(/JSON\.stringify\(proposal\.parentParcelIds/);
        });
    });
});
