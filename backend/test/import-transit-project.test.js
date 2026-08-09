// Importing a planner track as a track proposal. The parts worth pinning are the ones where a
// wrong answer is silent: a width that quietly differs from what was measured, a track dropped
// because its shape was not recognised, and — the one that matters most — the stored footprint,
// which consensus-builder trusts verbatim over anything it could re-derive.

import { describe, it, expect } from 'vitest';
import {
    WIDTH_PER_TRACK_M,
    parseArgs,
    tracksOf,
    widthForTrack,
    buildProposal
} from '../scripts/import-transit-project.mjs';

const project = {
    id: 141,
    author_name: 'Sibenik 4',
    project_hash: 'abc123',
    total_length_km: 17.1
};

const centreline = [
    { lat: 43.72, lng: 15.9, level: 0 },
    { lat: 43.73, lng: 15.9, level: -1 },
    { lat: 43.74, lng: 15.9, level: -1 },
    { lat: 43.75, lng: 15.9, level: 0 }
];

const footprint = {
    geometry: { type: 'MultiPolygon', coordinates: [[[[15.9, 43.72], [15.9, 43.73], [15.91, 43.73], [15.9, 43.72]]]] },
    areaM2: 93500
};

const parcels = [
    { id: 'HR-330264-3279/3', takenM2: 120, parcelM2: 800 },
    { id: 'HR-330264-3279/4', takenM2: 800, parcelM2: 800 }
];

const build = (overrides = {}) => buildProposal({
    project,
    track: { trackCount: 2 },
    trackIndex: 0,
    spans: [[centreline[0], centreline[1]], [centreline[2], centreline[3]]],
    centreline,
    footprint,
    parcels,
    widthM: 6,
    city: 'sibenik',
    ...overrides
});

describe('parseArgs', () => {
    it('is a dry run unless --apply is given', () => {
        expect(parseArgs(['--project', '141']).apply).toBe(false);
        expect(parseArgs(['--project', '141', '--apply']).apply).toBe(true);
        expect(parseArgs(['--project', '141', '--apply', '--dry-run']).apply).toBe(false);
    });

    it('reads the municipality filter as numbers, and treats an unusable one as absent', () => {
        expect(parseArgs(['--ko', '335533, 335541']).ko).toEqual([335533, 335541]);
        expect(parseArgs(['--ko', 'nonsense']).ko).toBeNull();
    });

    it('refuses an unknown argument rather than ignoring it', () => {
        expect(() => parseArgs(['--projct', '141'])).toThrow(/Unknown argument/);
    });
});

describe('tracksOf', () => {
    it('keeps only tracks that carry a drawable centreline', () => {
        const data = { tracks: [
            { latlngs: [[45, 15], [45.1, 15.1]] },
            { latlngs: [[45, 15]] },
            { latlngs: 'nope' },
            null
        ] };
        expect(tracksOf(data)).toHaveLength(1);
    });

    it('survives a project with no tracks at all', () => {
        expect(tracksOf(null)).toEqual([]);
        expect(tracksOf({})).toEqual([]);
    });
});

describe('widthForTrack', () => {
    it('scales the default with the number of parallel tracks', () => {
        expect(widthForTrack({ trackCount: 2 })).toBe(WIDTH_PER_TRACK_M * 2);
        expect(widthForTrack({ trackCount: 1 })).toBe(WIDTH_PER_TRACK_M);
        expect(widthForTrack({})).toBe(WIDTH_PER_TRACK_M);
    });

    it('lets an explicit override win, because the planner stores no land-take width', () => {
        expect(widthForTrack({ trackCount: 2 }, 12)).toBe(12);
        expect(widthForTrack({ trackCount: 2 }, 0)).toBe(WIDTH_PER_TRACK_M * 2);
    });
});

describe('buildProposal', () => {
    it('stores the measured footprint on the definition, where the app treats it as authoritative', () => {
        const definition = build().roadProposal.definition;
        expect(definition.polygon).toBe(footprint.geometry);
        expect(definition.width).toBe(6);
        expect(definition.metadata).toMatchObject({ type: 'track', isTrack: true, isRoad: false, levels: true });
    });

    it('keeps the centreline whole so a part-tunnelled line stays one contiguous stretch', () => {
        const definition = build().roadProposal.definition;
        // One segment, every vertex present — the tunnel gap lives in the footprint, not here.
        expect(definition.points).toHaveLength(1);
        expect(definition.points[0]).toHaveLength(centreline.length);
        expect(definition.segments).toEqual(definition.points);
    });

    it('reads as a track proposal to the rest of the app', () => {
        const proposal = build();
        expect(proposal.goal).toBe('road-track');
        expect(proposal.primaryType).toBe('Track');
        expect(proposal.isCorridor).toBe(true);
        expect(proposal.applied).toBeUndefined();
        expect(proposal.city).toBe('sibenik');
    });

    it('claims every parcel under the footprint as a parent', () => {
        const proposal = build();
        expect(proposal.parentParcelIds).toEqual(['HR-330264-3279/3', 'HR-330264-3279/4']);
        expect(proposal.cadastreParcelIds).toEqual(proposal.parentParcelIds);
        expect(proposal.roadProposal.parentParcelIds).toEqual(proposal.parentParcelIds);
    });

    it('records where it came from, and that it is a snapshot rather than a live view', () => {
        const source = build().source;
        expect(source).toMatchObject({ transitProjectId: 141, projectHash: 'abc123', snapshot: true });
    });

    it('is stably identified, so re-importing updates rather than duplicating', () => {
        expect(build().proposalId).toBe('transit-project-141-track-1');
        expect(build({ trackIndex: 1 }).proposalId).toBe('transit-project-141-track-2');
    });

    it('states the underground edges in the description, since they are what it does not take', () => {
        expect(build().description).toMatch(/1 underground/);
        expect(build().levelSummary).toMatchObject({ edges: 3, underground: 1 });
    });
});
