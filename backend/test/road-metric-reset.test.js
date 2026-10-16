// The road panel's metrics reset (frontend/js/road-drawing.js, resetRoadMetricPlaceholders): ending
// a drawing must clear length and area too, or the next drawing opens on the last road's figures.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../../frontend/js/road-drawing.js', import.meta.url)), 'utf8');

function lift(name) {
    const start = source.indexOf(`function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    return source.slice(start, source.indexOf('\n}', start) + 2);
}

describe('resetRoadMetricPlaceholders', () => {
    it('clears length and area along with the parcel figures', () => {
        const elements = new Map(['road-length', 'road-area', 'road-individual-owners', 'road-market-price', 'road-acquire-difficulty']
            .map(id => [id, { textContent: id === 'road-length' ? '412 m' : id === 'road-area' ? '6,180 m²' : 'stale' }]));
        const document = { getElementById: id => elements.get(id) || null };
        const CbFormat = { formatLength: m => `${m} m`, formatArea: m2 => `${m2} m²` };
        const roadOpenGroundCrossed = { locked: new Set(['a']), preview: new Set(['b']) };
        // eslint-disable-next-line no-new-func
        const reset = new Function('document', 'CbFormat', 'roadOpenGroundCrossed', 'setRoadParcelStats', 'ROAD_OWNERSHIP_TYPE_IDS', 'updateRoadAcquiringDifficulty',
            `${lift('resetRoadMetricPlaceholders')}; return resetRoadMetricPlaceholders;`)(
            document, CbFormat, roadOpenGroundCrossed, () => {}, {}, () => {});
        reset();
        expect(elements.get('road-length').textContent).toBe('0 m');
        expect(elements.get('road-area').textContent).toBe('0 m²');
        expect(elements.get('road-individual-owners').textContent).toBe('—');
        expect(roadOpenGroundCrossed.locked.size + roadOpenGroundCrossed.preview.size).toBe(0);
    });
});
