// Block detection either forms a block or explains itself in front of the user. It used to refuse
// into the status line — a message nobody was looking at — and then fly the camera to the parcel it
// was unhappy about and select it, throwing away the view and the selection to deliver what is only
// a message. Asserted at the source: the refusals are wiring, not a return value.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../frontend/js/parcel-blocks.js', import.meta.url), 'utf8');

function sectionOf(startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
    expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
    return source.slice(start, end);
}

// From the entry point to the first line of the success path: everything in between is a refusal.
const refusals = () => sectionOf('function selectCurrentBlockIntoMultiSelection(startParcel, options = {})', 'let addedCount = 0;');

describe('a block that cannot be formed', () => {
    it('says so in a dialog, not only in the status line', () => {
        const helper = sectionOf('function failBlockDetection(message)', 'function applyBlockTranslations');
        expect(helper).toContain('showStyledAlert');
        expect(helper).toContain('updateStatus'); // the status line keeps it too, as a second copy
    });

    it('routes every refusal through the loud path', () => {
        const body = refusals();
        expect(body).toContain('failBlockDetection(');
        // A bare status-line refusal is exactly the silent no-op this replaces.
        expect(body).not.toContain('updateStatus(');
    });

    it('names the parcel that broke it, and what the rule actually is', () => {
        const body = refusals();
        expect(body).toContain('block_neighbour_not_fully_visible');
        expect(body).toContain('block_seed_not_fully_visible');
        expect(body).toContain('{ id: idLabel }');
    });

    it('keeps the user’s camera and selection', () => {
        const body = refusals();
        expect(body).not.toContain('map.fitBounds(');
        expect(body).not.toContain('selectParcel(');
    });

    it('replaces stale source ids only after a whole block was formed successfully', () => {
        const success = sectionOf('if (options.replaceSelection === true)', 'const lastParcelId =');
        expect(success).toContain('multiParcelSelection.clearSelection()');
        expect(success).toContain('blockParcels.forEach');
    });
});
