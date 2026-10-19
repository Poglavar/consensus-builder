// The drawing tool's snapping glue (road-editor.md decision 4): Alt held places a point without
// snapping, existing streets reach the snap ladder, and the streets a road joins are remembered on
// the stored definition while only the connections still on its centre line survive. Drives the
// real road-drawing.js in the fake browser world (helpers/road-drawing-env.js), with an existing
// street served by a LegacyRoadCenterlines stand-in.
import { describe, it, expect, afterEach } from 'vitest';
import { loadRoadDrawing, at } from './helpers/road-drawing-env.js';

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// Ilica: an existing street running east–west 30 m north of the origin.
const ILICA = (() => {
    const points = [at(-50, 30), at(150, 30)];
    return {
        name: 'Ilica', wayId: '42', points,
        bbox: [points[0].lng, points[0].lat, points[1].lng, points[1].lat]
    };
})();

function loadWithStreets(lines = [ILICA]) {
    env = loadRoadDrawing({ globals: { LegacyRoadCenterlines: { snapLines: () => lines, ensureLoaded: () => {}, scheduleLoad: () => {} } } });
    return env;
}

async function openTool() {
    await env.api.requestCorridorDrawingTool('road');
    expect(env.session.roadDrawingMode).toBe(true);
}

describe('Alt places the point exactly where the pointer is', () => {
    it('reads Alt off the original DOM event', () => {
        const { roadSnapSuppressed } = loadRoadDrawing().api;
        expect(roadSnapSuppressed({ originalEvent: { altKey: true } })).toBe(true);
        expect(roadSnapSuppressed({ originalEvent: { altKey: false } })).toBe(false);
        expect(roadSnapSuppressed({})).toBe(false);
        expect(roadSnapSuppressed(null)).toBe(false);
    });

    it('is asked before any snap, on the hover and on the click', async () => {
        loadWithStreets();
        await openTool();
        // The hover: 3 m off the street shows the ring, unless Alt is held.
        await env.move(at(40, 27));
        expect(env.session.roadSnapMarker).not.toBeNull();
        await env.move(at(40, 27), { altKey: true });
        expect(env.session.roadSnapMarker).toBeNull();
        // The click: Alt leaves the point where the pointer is, without Alt it lands on the street.
        await env.click(at(40, 27), { altKey: true });
        expect(env.session.roadPoints[0].lat).toBeCloseTo(at(40, 27).lat, 12);
        expect(env.session.roadStreetConnections).toEqual([]);
        await env.click(at(40, 60));
        env.key('Escape');
        await env.idle();
        await env.click(at(80, 27));
        expect(env.session.roadPoints[0].lat).toBeCloseTo(at(0, 30).lat, 12);
    });
});

describe('existing streets in the snap ladder', () => {
    it('hands the nearby street lines to pickSnapTarget as its optional last list', () => {
        loadWithStreets();
        const snap = env.api.findRoadSnapTarget(at(40, 27));
        expect(snap).toMatchObject({ type: 'street-edge', source: 'street', wayId: '42', name: 'Ilica' });
        // ON the centre line, not a pixel's worth beside it.
        expect(snap.latlng.lat).toBeCloseTo(at(0, 30).lat, 12);
        expect(snap.latlng.lng).toBeCloseTo(at(40, 30).lng, 6);
        // Its vertex is a street node.
        expect(env.api.findRoadSnapTarget(at(147, 28))).toMatchObject({ type: 'street-node', source: 'street', wayId: '42' });
        // Too far from it: nothing.
        expect(env.api.findRoadSnapTarget(at(40, 0))).toBeNull();
    });

    it('projects only the lines whose box reaches the cursor', () => {
        const far = { name: 'far', wayId: '9', points: [at(1000, 1000), at(1100, 1000)] };
        far.bbox = [far.points[0].lng, far.points[0].lat, far.points[1].lng, far.points[1].lat];
        loadWithStreets([ILICA, far]);
        // A layer pixel is a metre east / a metre south here: the cursor 5 m south of Ilica.
        const cursor = env.map.latLngToLayerPoint(at(40, 25));
        expect(env.api.streetSnapLinesNear(cursor, 12).map(line => line.name)).toEqual(['Ilica']);
        expect(env.api.streetSnapLinesNear(cursor, 2)).toEqual([]);
    });

    it('remembers the street a click landed on, and nothing else', () => {
        const { api, session } = loadRoadDrawing();
        api.rememberRoadStreetConnection({ source: 'street', wayId: '42', name: 'Ilica' }, { lat: 45.8, lng: 15.97 });
        api.rememberRoadStreetConnection({ source: 'external', proposalId: 'p1' }, { lat: 45.9, lng: 15.9 });
        api.rememberRoadStreetConnection(null, { lat: 45.9, lng: 15.9 });
        expect(session.roadStreetConnections).toEqual([{ lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' }]);
    });

    it('keeps only connections still on the centre line, one per street and point', () => {
        const { liveRoadStreetConnections } = loadRoadDrawing().api;
        const kept = liveRoadStreetConnections([
            { lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' },
            { lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' },      // the same click twice
            { lat: 45.81, lng: 15.98, wayId: '43', name: 'Undone' }     // its vertex was undone
        ], [[{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.97 }]]);
        expect(kept).toEqual([{ lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' }]);
    });

    it('puts them on the drawing context and into the draft the stored definition is built from', async () => {
        loadWithStreets();
        await openTool();
        // A road from the south that meets Ilica, and a last point that touched it again but was undone.
        await env.click(at(40, -60));
        await env.click(at(40, 27));
        await env.click(at(100, 0));
        await env.click(at(110, 28));
        env.key('u');
        await env.idle();
        expect(env.session.roadStreetConnections).toHaveLength(2);
        env.key('f');
        await env.idle();

        const [joined] = globalThis.pendingRoadDrawingProposal.connections;
        expect(globalThis.pendingRoadDrawingProposal.connections).toHaveLength(1);
        expect(joined).toMatchObject({ wayId: '42', name: 'Ilica' });
        expect(joined.lat).toBeCloseTo(at(0, 30).lat, 12);
        const [draftId] = globalThis.instantCreateProposalFromDraft.calls[0];
        expect(env.draftStore.getDraft(draftId).editorPayload.definition.connections)
            .toEqual(globalThis.pendingRoadDrawingProposal.connections);
    });
});
