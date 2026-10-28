// Bets and Activity share the bottom dock frame. Designs owns a separate right-side panel.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const indexHtml = fs.readFileSync(path.join(FRONTEND, 'index.html'), 'utf8');
const DOCK_SHEETS = ['activity-sheet', 'bets-sheet'];

function openingTag(pattern) {
    const match = indexHtml.match(pattern);
    expect(match, String(pattern)).not.toBeNull();
    return match[0];
}

describe('dock sheets', () => {
    it('are exactly the sheets the bottom row opens, each with the shared frame', () => {
        const row = indexHtml.slice(indexHtml.indexOf('id="map-shell-bottom-right"'));
        const targets = [...row.slice(0, row.indexOf('</div>')).matchAll(/data-sheet-target="([^"]+)"/g)].map(m => m[1]);
        expect(targets).toEqual(['proposals-sheet', ...DOCK_SHEETS]);
        for (const id of DOCK_SHEETS) {
            expect(openingTag(new RegExp(`<section id="${id}"[^>]*>`)), id).toMatch(/class="[^"]*\bmap-sheet--dock\b/);
        }
    });

    it('anchor to the whole row, so switching between them moves nothing', () => {
        expect(openingTag(/<div id="map-shell-bottom-right"[^>]*>/)).toMatch(/\sdata-sheet-anchor[\s>]/);
    });

    it('keep Bets and Activity together in the shell stylesheet', () => {
        const cssDir = path.join(FRONTEND, 'css');
        const offenders = [];
        for (const file of ['map-shell.css']) {
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
