// Shared object inventory and movement retain authored metadata and enforce the current boundary.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { appTurf as turf } from '../agents/mcp-geometry.js';
const require = createRequire(import.meta.url);
const objects = require('../../frontend/js/structure-editor-objects.js');
const coordinates = require('../../frontend/js/geometry-edit/coordinates.js');
const boundary = turf.polygon([[[-.1,51.5],[-.098,51.5],[-.098,51.502],[-.1,51.502],[-.1,51.5]]]);
const tree = { coordinate: [-.099,51.501], kind: 'columnar', heightM: 12 };
const path = [[-.0995,51.5005],[-.0985,51.5005]];
const pond = [[-.0995,51.5005],[-.099,51.5005],[-.099,51.501],[-.0995,51.5005]];

describe('structure object editing', () => {
    it('lists points and shapes in their authored arrays with unambiguous type/index keys', () => {
        const entries = objects.entries({ trees: [tree], paths: [path], ponds: [pond], fountains: [[-.099,51.501]], version: 3 }, turf);
        expect(entries.map(entry => entry.key)).toEqual(['trees:0','ponds:0','paths:0','fountains:0']);
        expect(entries.map(entry => entry.tool)).toEqual(['tree','pond','path','fountain']);
        expect(entries[0].coordinate).toEqual(tree.coordinate);
        expect(entries[2].coordinate).toEqual([-.099,51.5005]);
    });
    it('moves an individual object without changing tree look or bench bearing', () => {
        const before = structuredClone(tree), point = [-.099,51.5015];
        expect(objects.move('trees', tree, point, boundary, turf, coordinates)).toEqual({ ...tree, coordinate: point });
        expect(objects.move('benches', { coordinate: tree.coordinate, bearing: 35 }, point, boundary, turf, coordinates)).toEqual({ coordinate: point, bearing: 35 });
        expect(tree).toEqual(before);
        expect(objects.move('trees', tree, [-.2,51.5], boundary, turf, coordinates)).toBeNull();
        expect(objects.move('trees', tree, [NaN,51.5], boundary, turf, coordinates)).toBeNull();
    });
    it('lists and moves lamps and market stalls while retaining their authored properties', () => {
        const lamp = { coordinate: tree.coordinate, heightM: 7, model: { url: '/uploads/models/lamp.glb' } };
        const stall = { coordinate: tree.coordinate, bearing: 50, heightM: 3 };
        const entries = objects.entries({ lamps: [lamp], stalls: [stall] }, turf);
        expect(entries.map(entry => entry.key)).toEqual(['stalls:0', 'lamps:0']);
        for (const [type, item] of [['lamps', lamp], ['stalls', stall]]) {
            const before = structuredClone(item), point = [-.099,51.5015];
            expect(objects.move(type, item, point, boundary, turf, coordinates)).toEqual({ ...item, coordinate: point });
            expect(item).toEqual(before);
        }
    });
    it('keeps playground equipment selectable and movable after integrating the park editor', () => {
        const item = { coordinate: tree.coordinate, bearing: 75 }, point = [-.099,51.5015];
        const entries = objects.entries({ swings: [item], seesaws: [item], slides: [item] }, turf);
        expect(entries.map(entry => entry.tool)).toEqual(['swing', 'seesaw', 'slide']);
        for (const type of ['swings', 'seesaws', 'slides']) {
            expect(objects.move(type, item, point, boundary, turf, coordinates)).toEqual({ ...item, coordinate: point });
            expect(item.coordinate).toEqual(tree.coordinate);
        }
    });
    it('moves every point of a path or pond and refuses a shape that would cross the boundary', () => {
        for (const [type, item] of [['paths',path],['ponds',pond]]) {
            const before = structuredClone(item), from = objects.position(type, item, turf), to = [from[0],from[1]+.0001];
            const next = objects.move(type,item,to,boundary,turf,coordinates);
            next.forEach((point,i) => { expect(point[0]).toBeCloseTo(item[i][0],10); expect(point[1]-item[i][1]).toBeCloseTo(.0001,10); });
            expect(item).toEqual(before);
            expect(objects.move(type,item,[-.098,51.502],boundary,turf,coordinates)).toBeNull();
        }
    });
});
