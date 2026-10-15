// The drawing tool's snapping glue (road-editor.md decision 4): Alt held places a point without
// snapping, existing streets reach the snap ladder, and the streets a road joins are remembered on
// the stored definition while only the connections still on its centre line survive.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const roadSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');

function lift(name) {
    let start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    if (roadSource.slice(start - 6, start) === 'async ') start -= 6;
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

// eslint-disable-next-line no-new-func
const load = name => new Function(`${lift(name)}; return ${name};`)();

describe('Alt places the point exactly where the pointer is', () => {
    const roadSnapSuppressed = load('roadSnapSuppressed');

    it('reads Alt off the original DOM event', () => {
        expect(roadSnapSuppressed({ originalEvent: { altKey: true } })).toBe(true);
        expect(roadSnapSuppressed({ originalEvent: { altKey: false } })).toBe(false);
        expect(roadSnapSuppressed({})).toBe(false);
        expect(roadSnapSuppressed(null)).toBe(false);
    });

    it('is asked before any snap, on the hover and on the click', () => {
        const move = lift('handleRoadMouseMove');
        const click = lift('handleRoadClick');
        expect(move).toContain('const snap = roadSnapSuppressed(e) ? null : findRoadSnapTarget(e.latlng);');
        expect(click).toContain('let snap = roadSnapSuppressed(e) ? null : findRoadSnapTarget(e.latlng);');
    });
});

describe('existing streets in the snap ladder', () => {
    it('hands the nearby street lines to pickSnapTarget as its optional last list', () => {
        const find = lift('findRoadSnapTarget');
        expect(find).toContain('const streetLines = streetSnapLinesNear(cursorPx, ROAD_SNAP_PIXELS);');
        expect(find).toContain('cursorPx, localSegments, externalSegments, activeIndex, ROAD_SNAP_PIXELS, streetSegments');
        expect(find).toMatch(/type: 'street-edge', source: 'street', wayId: line\.wayId, name: line\.name/);
    });

    it('projects only the lines whose box reaches the cursor', () => {
        const near = new Function('map', 'L', 'window', `${lift('streetSnapLinesNear')}; return streetSnapLinesNear;`)(
            // A plane where a container pixel is 1e-5° (x → lng, y → −lat), so the snap box is easy to state.
            { layerPointToLatLng: point => ({ lng: point.x * 1e-5, lat: -point.y * 1e-5 }) },
            { point: (x, y) => ({ x, y }) },
            {
                LegacyRoadCenterlines: {
                    snapLines: () => [
                        { name: 'near', bbox: [0.00095, -0.00105, 0.0011, -0.00095] },
                        { name: 'far', bbox: [0.01, 0.01, 0.02, 0.02] }
                    ]
                }
            }
        );
        expect(near({ x: 100, y: 100 }, 12).map(line => line.name)).toEqual(['near']);
    });

    it('remembers the street a click landed on, and nothing else', () => {
        const remember = new Function('roadStreetConnections', `${lift('rememberRoadStreetConnection')}; return rememberRoadStreetConnection;`);
        const connections = [];
        const rememberRoadStreetConnection = remember(connections);
        rememberRoadStreetConnection({ source: 'street', wayId: '42', name: 'Ilica' }, { lat: 45.8, lng: 15.97 });
        rememberRoadStreetConnection({ source: 'external', proposalId: 'p1' }, { lat: 45.9, lng: 15.9 });
        rememberRoadStreetConnection(null, { lat: 45.9, lng: 15.9 });
        expect(connections).toEqual([{ lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' }]);
    });

    it('keeps only connections still on the centre line, one per street and point', () => {
        const liveRoadStreetConnections = load('liveRoadStreetConnections');
        const kept = liveRoadStreetConnections([
            { lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' },
            { lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' },      // the same click twice
            { lat: 45.81, lng: 15.98, wayId: '43', name: 'Undone' }     // its vertex was undone
        ], [[{ lat: 45.8, lng: 15.97 }, { lat: 45.801, lng: 15.97 }]]);
        expect(kept).toEqual([{ lat: 45.8, lng: 15.97, wayId: '42', name: 'Ilica' }]);
    });

    it('puts them on the drawing context and into the draft the stored definition is built from', () => {
        const finish = lift('finishRoadDrawingOnce');
        expect(finish).toContain('connections: liveRoadStreetConnections(roadStreetConnections, centerlineSegments)');
        expect(finish).toContain('writeStreetConnectionsToDraft(designDraftId, roadDrawingContext.connections, centerlineSegments);');
    });
});
