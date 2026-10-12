// The bottom row's sheets (Proposals, Bets, Activity) share one frame: each is a .map-sheet--dock
// anchored to the whole row, so all three open in the same place at the same size, and no
// stylesheet sizes or places one of them on its own (css/map-shell.css owns the frame).
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const indexHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const DOCK_SHEETS = ['proposals-sheet', 'bets-sheet', 'activity-sheet'];

function openingTag(pattern) {
    const match = indexHtml.match(pattern);
    expect(match, String(pattern)).not.toBeNull();
    return match[0];
}

describe('dock sheets', () => {
    it('are exactly the sheets the bottom row opens, each with the shared frame', () => {
        const row = indexHtml.slice(indexHtml.indexOf('id="map-shell-bottom-right"'));
        const targets = [...row.slice(0, row.indexOf('</div>')).matchAll(/data-sheet-target="([^"]+)"/g)].map(m => m[1]);
        expect(targets).toEqual(DOCK_SHEETS);
        for (const id of DOCK_SHEETS) {
            expect(openingTag(new RegExp(`<section id="${id}"[^>]*>`)), id).toMatch(/class="[^"]*\bmap-sheet--dock\b/);
        }
    });

    it('anchor to the whole row, so switching between them moves nothing', () => {
        expect(openingTag(/<div id="map-shell-bottom-right"[^>]*>/)).toMatch(/\sdata-sheet-anchor[\s>]/);
    });

    it('are not sized or placed one by one in any stylesheet', () => {
        const cssDir = path.join(FRONTEND, 'css');
        const offenders = [];
        for (const file of fs.readdirSync(cssDir).filter(name => name.endsWith('.css'))) {
            const css = fs.readFileSync(path.join(cssDir, file), 'utf8');
            for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
                const selector = rule[1];
                if (!DOCK_SHEETS.some(id => new RegExp(`#${id}(?![\\w-])(?![^,]*\\s)`).test(selector.trim()))) continue;
                if (/(^|[;\s])(width|height|max-height|min-height|top|bottom|left|right)\s*:/.test(rule[2])) offenders.push(`${file}: ${selector.trim()}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
