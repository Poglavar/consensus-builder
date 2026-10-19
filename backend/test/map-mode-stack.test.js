// Guards the lower-left utility and mode strip: every strip button owns one declared slot, and no
// two buttons share one. The original cadastre control belongs in the 2D Layers sheet.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../../frontend/css/${name}`, import.meta.url), 'utf8');
const SOURCES = {
    'map.css': read('map.css'),
    'map-shell.css': read('map-shell.css'),
    'ai-scene.css': read('ai-scene.css'),
    'photoreal-mode.css': read('photoreal-mode.css')
};
const indexHtml = readFileSync(new URL('../../frontend/index.html', import.meta.url), 'utf8');

// Top → bottom. The slot each button is expected to own is the contract, not an observation:
// moving a button between slots means editing this list on purpose.
const STACK = [
    { id: 'measurement-button', slot: 1 },
    { id: 'mode-2d-toggle', slot: 2 },
    { id: 'mode-3d-toggle', slot: 3 },
    { id: 'mode-realistic-toggle', slot: 4 },
    { id: 'mode-ai-toggle', slot: 5 },
    { id: 'mode-walk-toggle', slot: 6 }
];

// Every `selector { body }` pair that declares a top offset for the given button id. Slots are top
// offsets counted up from the bottom row.
function topDeclarationsFor(id) {
    const selectorNeedle = id === 'measurement-button' ? '.map-utility-button' : `#${id}`;
    const found = [];
    for (const [file, css] of Object.entries(SOURCES)) {
        for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
            if (!selector.includes(selectorNeedle)) continue;
            const top = body.match(/(?:^|[;{\s])top:\s*([^;]+);/);
            if (top) found.push({ file, selector: selector.trim(), value: top[1].trim() });
        }
    }
    return found;
}

describe('left-edge map mode strip', () => {
    // The ladder's own declaration block (body, see css/map.css for why not :root).
    const ladder = () => {
        const block = SOURCES['map.css'].match(/body\s*\{([^{}]*--map-mode-slot-1[^{}]*)\}/);
        expect(block, 'body block with the slot ladder').toBeTruthy();
        return block[1];
    };

    it('anchors one ladder above the bottom row, the same in every view', () => {
        const block = ladder();
        expect(block).toMatch(/--map-mode-stack-bottom:\s*calc\(100dvh - var\(--app-safe-area-bottom, 0px\) - var\(--map-shell-bottom-clearance\)\);/);
        // The buttons never move between 2D, model and photo: no view redeclares a slot.
        for (const [file, css] of Object.entries(SOURCES)) {
            const declarations = css.match(/--map-mode-slot-\d+:/g) || [];
            expect(declarations.length, `${file} declares mode slots`).toBe(file === 'map.css' ? STACK.length : 0);
        }
    });

    it('declares one slot ladder, evenly spaced, with no repeated offset, ending on the bottom row', () => {
        const block = ladder();
        const offsets = STACK.map(({ slot }) => {
            const declared = block.match(new RegExp(`--map-mode-slot-${slot}:\\s*calc\\(var\\(--map-mode-stack-bottom\\) - (\\d+)px\\)`));
            expect(declared, `--map-mode-slot-${slot} is counted up from --map-mode-stack-bottom`).toBeTruthy();
            return Number(declared[1]);
        });

        expect(new Set(offsets).size, `two slots share an offset: ${offsets.join(', ')}`).toBe(offsets.length);
        offsets.forEach((offset, i) => {
            if (i === 0) return;
            // 36px button + 12px gap. Anything tighter overlaps the neighbour's box.
            expect(offsets[i - 1] - offset, `gap between slot ${i} and ${i + 1}`).toBe(48);
        });
        // The last 36px button ends on the bottom row's line, not inside it.
        expect(offsets.at(-1)).toBe(36);
    });

    it('gives every button its own slot, and none a hand-picked offset', () => {
        const owners = new Map();
        for (const { id, slot } of STACK) {
            const declarations = topDeclarationsFor(id);
            expect(declarations.length, `${id} should declare its top exactly once`).toBe(1);
            expect(declarations[0].value, `${id} must sit in a declared slot, not a raw offset`)
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

    it('keeps the original cadastre control in the 2D Layers sheet', () => {
        const layers = indexHtml.slice(indexHtml.indexOf('id="layers-sheet"'), indexHtml.indexOf('id="measurement-sheet"'));
        expect(layers).toContain('id="cadastre-view-toggle"');
        expect(layers).toMatch(/id="cadastre-view-toggle"[^>]*data-map-modes="2d"/);
        expect(topDeclarationsFor('cadastre-view-toggle')).toEqual([]);
    });
});
