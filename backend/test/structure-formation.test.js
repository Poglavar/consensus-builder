// Every park, square and lake follows one parcel-formation path; stations remain content on their
// corridor and therefore form no ground of their own.

import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';

const require = createRequire(import.meta.url);
const structures = require('../../frontend/js/proposals/apply/structures.js');
const {
    structureNeedsGroundFormation,
    structureTakeContext,
    structureGeometryIsContiguous
} = structures;
const formationEdit = require('../../frontend/js/proposals/formation-edit.js');
const parcelArrangement = require('../../frontend/js/proposals/parcel-arrangement.js');

function box(west, south, east, north, id = null) {
    return {
        type: 'Feature',
        properties: id ? { parcelId: id } : {},
        geometry: {
            type: 'Polygon',
            coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]]
        }
    };
}

describe('structure ground formation', () => {
    it('forms ground for every land-based structure kind', () => {
        expect(structureNeedsGroundFormation('park')).toBe(true);
        expect(structureNeedsGroundFormation('square')).toBe(true);
        expect(structureNeedsGroundFormation('lake')).toBe(true);
    });

    it('keeps stations content-only on their corridor', () => {
        expect(structureNeedsGroundFormation('station')).toBe(false);
    });

    it('does not require non-corridor live ground beneath an attached station', async () => {
        const originalGlobals = new Map([
            ['_normalizeProposalId', globalThis._normalizeProposalId],
            ['appliedOf', globalThis.appliedOf],
            ['persistAppliedProposal', globalThis.persistAppliedProposal],
            ['refreshProposalUIAfterApply', globalThis.refreshProposalUIAfterApply]
        ]);
        const proposal = {
            proposalId: 'station-over-track',
            title: 'Track station',
            applied: false,
            structureProposal: {
                kind: 'station',
                stationType: 'tram',
                geometry: box(15.9798, 45.8098, 15.9802, 45.8102).geometry
            }
        };
        const resolveLiveFormationParents = vi.fn(() => {
            throw new Error('a station must not seek non-corridor parent pieces');
        });
        const collections = { parks: [], lakes: [], squares: [], transitStations: [] };

        try {
            globalThis._normalizeProposalId = value => String(value || '');
            globalThis.appliedOf = value => value.applied === true;
            globalThis.persistAppliedProposal = value => { value.applied = true; };
            globalThis.refreshProposalUIAfterApply = vi.fn();

            const result = await structures._applyStructureProposal.call({
                _getCanonicalStructureGeometry: () => proposal.structureProposal.geometry,
                _deriveDemolishedBuildings: vi.fn().mockResolvedValue([]),
                _resolveLiveFormationParents: resolveLiveFormationParents,
                _setLastApplyFailure: vi.fn()
            }, proposal.proposalId, proposal, {
                deferPresentation: true,
                _parcelMutation: {
                    collections,
                    afterCommit: vi.fn()
                }
            });

            expect(result).toBe(true);
            expect(resolveLiveFormationParents).not.toHaveBeenCalled();
            expect(collections.transitStations).toHaveLength(1);
            expect(proposal.applied).toBe(true);
        } finally {
            for (const [key, value] of originalGlobals.entries()) {
                if (value === undefined) delete globalThis[key];
                else globalThis[key] = value;
            }
        }
    });

    it('requires parks, squares and lakes to occupy exactly one connected polygon', () => {
        const polygon = box(15.87, 43.74, 15.88, 43.75).geometry;
        const onePart = { type: 'MultiPolygon', coordinates: [polygon.coordinates] };
        const twoParts = {
            type: 'MultiPolygon',
            coordinates: [
                polygon.coordinates,
                box(15.89, 43.76, 15.90, 43.77).geometry.coordinates
            ]
        };

        expect(structureGeometryIsContiguous('park', polygon)).toBe(true);
        expect(structureGeometryIsContiguous('square', onePart)).toBe(true);
        expect(structureGeometryIsContiguous('lake', twoParts)).toBe(false);
        expect(structureGeometryIsContiguous('station', twoParts)).toBe(true);
    });

    it('measures a whole Sibenik block with the hardened fabric clipper', () => {
        const west = 15.873701234414993;
        const split = west + 0.001;
        const east = split + 0.001;
        const footprint = box(west, 43.754, east, 43.755);
        const candidates = [
            { id: 'west', feature: box(west, 43.754, split, 43.755, 'west') },
            { id: 'east', feature: box(split, 43.754, east, 43.755, 'east') }
        ];
        const fragileTurf = {
            ...turf,
            intersect: vi.fn(() => { throw new Error('Unable to complete output ring'); })
        };
        const clip = vi.fn((operation, left, right) => parcelArrangement.clip(operation, left, right));
        const priorTurf = globalThis.turf;
        globalThis.turf = turf;
        let plan;
        try {
            plan = formationEdit.wholeParcelTakePlan(
                footprint,
                candidates,
                structureTakeContext(fragileTurf, { clip })
            );
        } finally {
            if (priorTurf === undefined) delete globalThis.turf;
            else globalThis.turf = priorTurf;
        }

        expect(plan.mode).toBe('merge');
        expect(plan.uncoveredShare).toBeLessThan(0.000001);
        expect(clip).toHaveBeenCalled();
        expect(fragileTurf.intersect).not.toHaveBeenCalled();
    });
});
