// The road tool's parcel stats on open ground (PARCEL-OPTIONAL.md phase 6b): a corridor drawn across
// pieces formed on open ground (subdivision plots, parks with no cadastral parcel) must not count
// them as parcels or their (absent) owners — "Parcel count 3 · Individual owners 3" for three
// ownerless plots was the bug — and shows them as open ground instead. Drives the real road-drawing.js
// in the fake browser world (helpers/road-drawing-env.js) over a live fabric of those pieces, with the
// real proposals/open-ground.js and the English dictionary behind window.i18n.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { loadRoadDrawing, at, boxRing } from './helpers/road-drawing-env.js';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const openGround = require('../../frontend/js/proposals/open-ground.js');

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

let env = null;
afterEach(() => {
    env?.dispose();
    env = null;
});

// Pieces of the fabric, 10 m to a unit east of the drawing origin and 40 m deep.
const U = 10;
const GROUND = 'ground:' + 'a'.repeat(64);
const plot = (id, x0, x1) => ({
    id, ring: boxRing(x0 * U, 0, x1 * U, 4 * U),
    properties: { cadastreParcelIds: [], groundIds: [GROUND], producedByProposalId: 'sub', calculatedArea: 1000 }
});
const cadastral = (id, x0, x1) => ({
    id, ring: boxRing(x0 * U, 0, x1 * U, 4 * U),
    properties: { cadastreParcelIds: [id], calculatedArea: 2000, ownershipList: [{ name: 'Ana' }], ownershipType: 'individual' }
});

// An English window.i18n over the real dictionary, the way the page has it.
function englishI18n(dict = dictOf('en')) {
    return {
        t: (key, params = {}) => {
            const value = key.split('.').reduce((node, part) => (node ? node[part] : undefined), dict);
            return typeof value === 'string' ? value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in params ? params[k] : m)) : key;
        }
    };
}

// The tool over `pieces`, with the open-ground stat inside its metric group (hidden until used).
function loadStats(pieces) {
    env = loadRoadDrawing({ parcels: pieces, globals: { __openGround: openGround, i18n: englishI18n() } });
    const group = { hidden: true };
    env.element('road-open-ground').closest = selector => (selector === '.metric-group' ? group : null);
    return { lockParcelsFromSegment: env.api.lockParcelsFromSegment, stats: () => env.session.lockedStats, group };
}
const text = id => env.element(id).textContent;

// The land of a 10 m wide road from x0 to x1 (units), through the middle of the pieces.
const segment = (x0, x1) => boxRing(x0 * U, 1.5 * U, x1 * U, 2.5 * U).map(([lng, lat]) => ({ lng, lat }));

describe('road tool stats over open ground', () => {
    it('counts no parcel and no owner for ownerless plots, and shows them as open ground', async () => {
        const { stats, group } = loadStats([plot('sub-1', 0, 4), plot('sub-2', 4, 8), plot('sub-3', 8, 12)]);
        // Drawn for real: one edge across all three plots.
        await env.api.requestCorridorDrawingTool('road');
        await env.click(at(-1 * U, 2 * U));
        await env.click(at(13 * U, 2 * U));
        expect(stats().parcelCount).toBe(0);
        expect(stats().individualOwners).toBe(0);
        expect(text('road-parcels-count')).toBe('0');
        expect(text('road-individual-owners')).toBe('—');
        expect(group.hidden).toBe(false);
        expect(text('road-open-ground')).toBe(`3 · ${globalThis.CbFormat.formatArea(3000)}`);
    });

    it('counts the cadastral parcel and its owner beside the open ground', () => {
        const { lockParcelsFromSegment, stats } = loadStats([cadastral('HR-1', -8, 0), plot('sub-1', 0, 4)]);
        lockParcelsFromSegment(segment(-4, 2));
        expect(stats().parcelCount).toBe(1);
        expect(stats().individualOwners).toBe(1);
        expect(text('road-parcels-count')).toBe('1');
        expect(text('road-open-ground')).toBe(`1 · ${globalThis.CbFormat.formatArea(1000)}`);
    });

    it('hides the open-ground stat on a purely cadastral road', () => {
        const { lockParcelsFromSegment, stats, group } = loadStats([cadastral('HR-1', -8, 0)]);
        lockParcelsFromSegment(segment(-4, -1));
        expect(stats().parcelCount).toBe(1);
        expect(group.hidden).toBe(true);
        expect(text('road-open-ground')).toBe('—');
    });

    it('has the open-ground label in every locale', () => {
        ['en', 'hr', 'es', 'sr'].forEach(locale => {
            const road = dictOf(locale).panel.road;
            expect(road.openGroundLabel, locale).toBeTruthy();
            expect(road.openGroundValue, locale).toContain('{{area}}');
        });
    });
});

describe('splitCrossedPieces', () => {
    // The same pieces as GeoJSON features, the shape the fabric hands open-ground.js.
    const feature = piece => turf.polygon([piece.ring], { parcelId: piece.id, ...piece.properties });

    it('separates parcels from ground pieces, deduplicates ground ids and measures missing areas', () => {
        const unmeasured = feature(plot('sub-9', 0, 4));
        delete unmeasured.properties.calculatedArea;
        const result = openGround.splitCrossedPieces([feature(cadastral('HR-1', -8, 0)), feature(plot('sub-1', 0, 4)), feature(plot('sub-1', 0, 4)), unmeasured], { turf });
        expect(result.parcels.map(f => f.properties.parcelId)).toEqual(['HR-1']);
        expect(result.ground.count).toBe(2);
        expect(result.ground.pieces[0]).toEqual({ id: 'sub-1', areaM2: 1000 });
        expect(result.ground.pieces[1].areaM2).toBeCloseTo(turf.area(unmeasured), 3);
    });
});

describe('Croatian uses "čestica" for a parcel', () => {
    it('says "sadrži 1 česticu" in the selected-proposal status line', () => {
        const summary = dictOf('hr').status.messages.selected_proposal_summary;
        expect(summary.one).toContain('{{count}} česticu');
        expect(summary.few).toContain('{{count}} čestice');
        expect(summary.other).toContain('{{count}} čestica');
    });

    it('has no inflected "parcela" left in user-facing Croatian strings', () => {
        const strings = [];
        const walk = node => {
            if (typeof node === 'string') strings.push(node);
            else if (node && typeof node === 'object') Object.values(node).forEach(walk);
        };
        walk(dictOf('hr'));
        const offenders = strings.filter(value => /(?<![\w{])[Pp]arcel(a|e|u|i|om|ama)(?![\w}])/.test(value));
        expect(offenders).toEqual([]);
    });
});
