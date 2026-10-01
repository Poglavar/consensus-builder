// The road tool's parcel stats on open ground (PARCEL-OPTIONAL.md phase 6b): a corridor drawn across
// pieces formed on open ground (subdivision plots, parks with no cadastral parcel) must not count
// them as parcels or their (absent) owners — "Parcel count 3 · Individual owners 3" for three
// ownerless plots was the bug — and shows them as open ground instead. Runs the real road-drawing
// functions (lifted from the classic script) over a fake fabric and DOM.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const turf = require('@turf/turf');
const openGround = require('../../frontend/js/proposals/open-ground.js');

const read = rel => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const roadSource = read('../../frontend/js/road-drawing.js');
const dictOf = locale => JSON.parse(read(`../../frontend/i18n/${locale}.json`));

function lift(name) {
    const start = roadSource.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return roadSource.slice(start, roadSource.indexOf('\n}', start) + 2);
}

const LON = 139.76;
const LAT = 35.68;
const U = 1e-4;
const rect = (x0, y0, x1, y1) => turf.polygon([[
    [LON + x0 * U, LAT + y0 * U], [LON + x1 * U, LAT + y0 * U],
    [LON + x1 * U, LAT + y1 * U], [LON + x0 * U, LAT + y1 * U],
    [LON + x0 * U, LAT + y0 * U]
]]);
const GROUND = 'ground:' + 'a'.repeat(64);
const plot = (id, x0, x1) => {
    const feature = rect(x0, 0, x1, 4);
    feature.properties = { parcelId: id, cadastreParcelIds: [], groundIds: [GROUND], producedByProposalId: 'sub', calculatedArea: 1000 };
    return feature;
};
const cadastral = (id, x0, x1) => {
    const feature = rect(x0, 0, x1, 4);
    feature.properties = {
        parcelId: id, cadastreParcelIds: [id], calculatedArea: 2000,
        ownershipList: [{ name: 'Ana' }], ownershipType: 'individual'
    };
    return feature;
};

// A minimal DOM: elements by id, each in a metric group whose `hidden` the stat toggles.
function fakeDocument() {
    const elements = new Map();
    return {
        elements,
        getElementById(id) {
            if (!elements.has(id)) {
                const group = { hidden: id === 'road-open-ground' };
                elements.set(id, { textContent: '', group, closest: () => group });
            }
            return elements.get(id);
        }
    };
}

function loadStats(features, dict = dictOf('en')) {
    const document = fakeDocument();
    const fabric = { queryBounds: () => features.slice() };
    const lookup = (key, params) => {
        const value = key.split('.').reduce((node, part) => (node ? node[part] : undefined), dict);
        return typeof value === 'string' ? value.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in params ? params[k] : m)) : null;
    };
    // eslint-disable-next-line no-new-func
    const api = new Function(
        'window', 'document', 'turf', 'getRoadDrawingFabric', 'getRoadDrawingPresenterLayer',
        'getRoadDrawingParcelIdFromFeature', 'getRoadDrawingParcelProperties', 'getOwnershipTypeFromParcel',
        'ensurePolygonIsClosed', 'setRoadOwnershipCounts', 'updateRoadAcquiringDifficulty', 'formatCurrency',
        'translateRoadText', 'formatParcelArea',
        `let lockedParcelIds = new Set();
         let lockedStats = { parcelCount: 0, totalArea: 0, ownershipCounts: { individual: 0, company: 0, government: 0, institution: 0, mixed: 0 }, marketPrice: 0, individualOwners: 0 };
         let roadAffectedParcels = [];
         let roadSegmentHistory = [];
         const roadOpenGroundCrossed = { locked: new Map(), preview: new Map() };
         ${lift('liveRoadDrawingParcelsIntersecting')}
         ${lift('roadDrawingParcelEntry')}
         ${lift('findNewAffectedParcelsForSegment')}
         ${lift('lockParcelsFromSegment')}
         ${lift('setRoadParcelStats')}
         ${lift('renderRoadOpenGroundStat')}
         return { lockParcelsFromSegment, stats: () => lockedStats };`
    )(
        { __openGround: openGround },
        document,
        turf,
        () => fabric,
        () => null,
        feature => feature.properties.parcelId,
        parcel => (features.find(f => f.properties.parcelId === parcel.id) || {}).properties || {},
        () => 'individual',
        ring => ring,
        () => {},
        () => {},
        value => String(value),
        (key, fallback, params = {}) => lookup(key, params) || fallback.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in params ? params[k] : m)),
        area => `${Math.round(area)} m²`
    );
    return { ...api, document };
}

const segment = (x0, x1) => rect(x0, 1, x1, 2).geometry.coordinates[0].map(([lng, lat]) => ({ lng, lat }));

describe('road tool stats over open ground', () => {
    it('counts no parcel and no owner for ownerless plots, and shows them as open ground', () => {
        const { lockParcelsFromSegment, stats, document } = loadStats([plot('sub-1', 0, 4), plot('sub-2', 4, 8), plot('sub-3', 8, 12)]);
        lockParcelsFromSegment(segment(-1, 13));
        expect(stats().parcelCount).toBe(0);
        expect(stats().individualOwners).toBe(0);
        expect(document.getElementById('road-parcels-count').textContent).toBe('0');
        expect(document.getElementById('road-individual-owners').textContent).toBe('—');
        const open = document.getElementById('road-open-ground');
        expect(open.group.hidden).toBe(false);
        expect(open.textContent).toBe('3 · 3000 m²');
    });

    it('counts the cadastral parcel and its owner beside the open ground', () => {
        const { lockParcelsFromSegment, stats, document } = loadStats([cadastral('HR-1', -8, 0), plot('sub-1', 0, 4)]);
        lockParcelsFromSegment(segment(-4, 2));
        expect(stats().parcelCount).toBe(1);
        expect(stats().individualOwners).toBe(1);
        expect(document.getElementById('road-open-ground').textContent).toBe('1 · 1000 m²');
    });

    it('hides the open-ground stat on a purely cadastral road', () => {
        const { lockParcelsFromSegment, stats, document } = loadStats([cadastral('HR-1', -8, 0)]);
        lockParcelsFromSegment(segment(-4, -1));
        expect(stats().parcelCount).toBe(1);
        expect(document.getElementById('road-open-ground').group.hidden).toBe(true);
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
    it('separates parcels from ground pieces, deduplicates ground ids and measures missing areas', () => {
        const unmeasured = plot('sub-9', 0, 4);
        delete unmeasured.properties.calculatedArea;
        const result = openGround.splitCrossedPieces([cadastral('HR-1', -8, 0), plot('sub-1', 0, 4), plot('sub-1', 0, 4), unmeasured], { turf });
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
