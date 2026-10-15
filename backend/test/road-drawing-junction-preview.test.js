// The junction with an applied road is previewed while drawing (road-editor.md decision 4): the
// applied corridors that share a node with the drawing — at one of their vertices, or part-way along
// an edge where Finish will node it in — join the junction pass as short arms around that node.
// Tests the pure arm selection lifted from road-drawing.js, and that the junction builder then
// draws a junction the drawing takes part in.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const roadSource = readFileSync(new URL('../../frontend/js/road-drawing.js', import.meta.url), 'utf8');

function lift(name) {
    const start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

// eslint-disable-next-line no-new-func
const appliedArmsMeetingDrawing = new Function(`${lift('appliedArmsMeetingDrawing')}; return appliedArmsMeetingDrawing;`)();

const P = (lat, lng) => ({ lat, lng });
const PROFILE = { strips: [{ type: 'sidewalk', width: 2 }, { type: 'driving', width: 6 }, { type: 'sidewalk', width: 2 }] };
// An applied east–west street near Zagreb with a bend vertex in the middle.
const street = { points: [P(45.8, 15.97), P(45.8, 15.971), P(45.8, 15.972)], profile: PROFILE, corridorId: 'p1' };

describe('applied arms meeting the drawing', () => {
    it('takes the arms around an applied vertex the drawing shares', () => {
        const drawing = [[P(45.8, 15.971), P(45.801, 15.971)]];
        const arms = appliedArmsMeetingDrawing(drawing, [street]);
        expect(arms).toEqual([{ points: [P(45.8, 15.97), P(45.8, 15.971), P(45.8, 15.972)], profile: PROFILE, corridorId: 'p1' }]);
    });

    it('finds a T snapped onto the middle of an applied edge, around the drawing’s exact node', () => {
        const t = 0.37;
        const onEdge = P(45.8, 15.97 + t * 0.001);
        const arms = appliedArmsMeetingDrawing([[P(45.799, onEdge.lng), onEdge]], [street]);
        expect(arms).toHaveLength(1);
        expect(arms[0].points).toEqual([P(45.8, 15.97), onEdge, P(45.8, 15.971)]);
    });

    it('takes one arm at an applied road’s end', () => {
        const arms = appliedArmsMeetingDrawing([[P(45.8, 15.972), P(45.801, 15.973)]], [street]);
        expect(arms[0].points).toEqual([P(45.8, 15.971), P(45.8, 15.972)]);
    });

    it('leaves alone a near miss that is not a shared node', () => {
        // 2 cm north of the centre line: snapping would have landed on it; this did not.
        const nearMiss = P(45.8 + 0.02 / 111320, 15.9705);
        expect(appliedArmsMeetingDrawing([[P(45.799, 15.9705), nearMiss]], [street])).toEqual([]);
        expect(appliedArmsMeetingDrawing([[P(45.81, 15.98), P(45.811, 15.98)]], [street])).toEqual([]);
    });

    it('gives the junction builder a junction the drawing takes part in', () => {
        const { buildCorridorJunctionTreatmentsForEntries } = require('../../frontend/js/corridor-profile.js');
        const frame = require('../../frontend/js/metric-frame.js').frameAt([15.971, 45.8]);
        const onEdge = P(45.8, 15.9705);
        const drawing = [{ points: [P(45.7995, 15.9705), onEdge], profile: PROFILE, corridorId: 'active-drawing' }];
        // The drawing alone ends in a dead end: no junction to draw.
        expect(buildCorridorJunctionTreatmentsForEntries(drawing, frame)).toEqual([]);
        const arms = appliedArmsMeetingDrawing(drawing.map(entry => entry.points), [street]);
        const junctions = buildCorridorJunctionTreatmentsForEntries(drawing.concat(arms), frame);
        expect(junctions).toHaveLength(1);
        expect(junctions[0].degree).toBe(3);
        expect(junctions[0].lat).toBeCloseTo(onEdge.lat, 7);
        expect(junctions[0].lng).toBeCloseTo(onEdge.lng, 7);
        expect([...junctions[0].corridorIds].sort()).toEqual(['active-drawing', 'p1']);
    });
});

describe('the preview is wired into the junction pass only', () => {
    const redraw = lift('redrawRoadStrips');

    it('adds the applied arms to the junction builder, never to the strips or markings', () => {
        expect(redraw).toContain('const appliedArms = appliedJunctionArmsForDrawing(entries);');
        expect(redraw).toContain('buildCorridorJunctionTreatmentsForEntries(pieces.concat(appliedArms), frame)');
        expect(redraw).toContain('buildCorridorLaneMarkingsForEntries(pieces, frame, { junctions })');
        expect(redraw).not.toMatch(/buildCorridorStrips\([^)]*appliedArms/);
    });

    it('draws the transition pieces like the applied renderer does', () => {
        expect(redraw).toContain('corridorRenderPieces(entries, frame)');
        expect(redraw).toMatch(/piece\.taper && typeof buildCorridorPieceStrips === 'function'\)\s*\? buildCorridorPieceStrips\(piece, frame\)\s*: buildCorridorStrips\(\[piece\.points\], piece\.profile, frame\)/);
    });

    it('keeps only junctions the drawing takes part in', () => {
        expect(redraw).toMatch(/junction\.corridorIds\.includes\('active-drawing'\)/);
    });

    it('looks at applied corridors of either kind, near the drawing only', () => {
        const gather = lift('appliedJunctionArmsForDrawing');
        expect(gather).toContain('isApplied(proposal, proposal.roadProposal)');
        expect(gather).not.toContain('corridorIsTrack');
        expect(gather).toMatch(/own\[0\] > box\[2\] \+ pad/);
    });
});
