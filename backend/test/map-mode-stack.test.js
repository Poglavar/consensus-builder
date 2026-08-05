// Guards the lower-left map mode stack: every button owns one declared slot, and no two buttons
// share one. They are all absolutely positioned at the same `left`, so a shared slot is not a
// visible layout squeeze — the button later in index.html paints over the other and the covered
// one becomes unreachable. That has happened twice (walk over the AI wand at 192, then the
// cadastre grid over walk at 240), each time reported as "the icon is missing".
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../../frontend/css/${name}`, import.meta.url), 'utf8');
const SOURCES = {
    'map.css': read('map.css'),
    'ai-scene.css': read('ai-scene.css'),
    'photoreal-mode.css': read('photoreal-mode.css')
};
const indexHtml = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

// The stack, bottom → top. The slot each button is expected to own is the contract, not an
// observation: moving a button between slots means editing this list on purpose.
const STACK = [
    { id: 'cadastre-view-toggle', slot: 1 },
    { id: 'mode-2d-toggle', slot: 2 },
    { id: 'mode-3d-toggle', slot: 3 },
    { id: 'mode-realistic-toggle', slot: 4 },
    { id: 'mode-ai-toggle', slot: 5 },
    { id: 'mode-walk-toggle', slot: 6 }
];

// Every `selector { body }` pair that declares a bottom offset for the given button id.
function bottomDeclarationsFor(id) {
    const found = [];
    for (const [file, css] of Object.entries(SOURCES)) {
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!selector.includes(`#${id}`)) continue;
            const bottom = body.match(/(?:^|[;{\s])bottom:\s*([^;]+);/);
            if (bottom) found.push({ file, selector: selector.trim(), value: bottom[1].trim() });
        }
    }
    return found;
}

describe('lower-left map mode stack', () => {
    it('declares one slot ladder, evenly spaced, with no repeated offset', () => {
        const root = SOURCES['map.css'].match(/:root\s*\{([\s\S]*?)\}/);
        expect(root, ':root block with the slot ladder').toBeTruthy();

        const offsets = STACK.map(({ slot }) => {
            const declared = root[1].match(new RegExp(`--map-mode-slot-${slot}:\\s*(\\d+)px`));
            expect(declared, `--map-mode-slot-${slot} is defined in :root`).toBeTruthy();
            return Number(declared[1]);
        });

        expect(new Set(offsets).size, `two slots share an offset: ${offsets.join(', ')}`).toBe(offsets.length);
        offsets.forEach((offset, i) => {
            if (i === 0) return;
            // 36px button + 12px gap. Anything tighter overlaps the neighbour's box.
            expect(offset - offsets[i - 1], `gap between slot ${i} and ${i + 1}`).toBe(48);
        });
    });

    it('gives every button its own slot, and none a hand-picked offset', () => {
        const owners = new Map();
        for (const { id, slot } of STACK) {
            const declarations = bottomDeclarationsFor(id);
            expect(declarations.length, `#${id} should declare its bottom exactly once`).toBe(1);
            expect(declarations[0].value, `#${id} must sit in a declared slot, not a raw offset`)
                .toBe(`var(--map-mode-slot-${slot})`);

            const clash = owners.get(slot);
            expect(clash, `#${id} and #${clash} both claim slot ${slot} — one would paint over the other`)
                .toBeUndefined();
            owners.set(slot, id);
        }
    });

    it('keeps every stack button in the markup, so a slot cannot quietly go unused', () => {
        for (const { id } of STACK) expect(indexHtml).toContain(`id="${id}"`);
    });
});
