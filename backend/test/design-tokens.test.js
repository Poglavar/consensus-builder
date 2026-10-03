// The design-language ratchets for CSS (docs/design-language.md, backend/test/helpers/design-audit.mjs).
//
// Why ratchets: the frontend has ~700 colour literals, 148 z-index declarations and 142 !important
// spread over 35 stylesheets, and every new feature copied whichever neighbour it was built next to.
// A hard "zero literals" rule would fail forever; a per-file ceiling that may only go DOWN catches the
// next regression at the current level and records progress. After reducing a file, rerun
// `node backend/test/helpers/design-audit.mjs --write` so the ceiling drops with it.
//
// The non-ratchet rules here are the ones that produced verified bugs: tokens must load first, no
// `#id` inside an `:is()` list (it gave the whole close-button rule ID specificity, so its large
// variant never applied anywhere), and one spelling of the phone/desktop edge (767/768/769 used to
// coexist, so the shell and the panels disagreed at exactly 768px).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    FRONTEND, auditNow, readBaseline, idsInsideIsLists, breakpointViolations, coLoadedCssFiles, listFiles,
    stripCssComments
} from './helpers/design-audit.mjs';

const baseline = readBaseline();
const now = auditNow();
const cssFiles = listFiles(path.join(FRONTEND, 'css'), '.css').map(f => path.relative(FRONTEND, f).replace(/\\/g, '/')).sort();

describe('design tokens load first', () => {
    it('index.html loads tokens.css and primitives.css before every other stylesheet', () => {
        const list = coLoadedCssFiles(readFileSync(path.join(FRONTEND, 'index.html'), 'utf8'));
        expect(list.slice(0, 2)).toEqual(['css/tokens.css', 'css/primitives.css']);
    });

    it('index.css (the static pages) imports them first and nothing that does not exist', () => {
        const css = readFileSync(path.join(FRONTEND, 'index.css'), 'utf8');
        const imports = [...css.matchAll(/@import url\('([^']+)'\)/g)].map(m => m[1]);
        expect(imports.slice(0, 2)).toEqual(['css/tokens.css', 'css/primitives.css']);
        imports.forEach(file => {
            expect({ file, exists: cssFiles.includes(file) }).toEqual({ file, exists: true });
        });
    });

    it('every --cb-* token used anywhere is defined in tokens.css', () => {
        const tokens = readFileSync(path.join(FRONTEND, 'css', 'tokens.css'), 'utf8');
        const defined = new Set([...tokens.matchAll(/(--cb-[a-z0-9-]+)\s*:/g)].map(m => m[1]));
        const missing = new Set();
        cssFiles.forEach(file => {
            const css = stripCssComments(readFileSync(path.join(FRONTEND, file), 'utf8'));
            [...css.matchAll(/var\((--cb-[a-z0-9-]+)/g)].forEach(m => {
                if (!defined.has(m[1]) && !css.includes(m[1] + ':')) missing.add(`${file}: ${m[1]}`);
            });
        });
        expect([...missing]).toEqual([]);
    });
});

describe('selector hygiene', () => {
    it.each(cssFiles)('%s has no #id inside an :is() list', (file) => {
        expect(idsInsideIsLists(readFileSync(path.join(FRONTEND, file), 'utf8'))).toEqual([]);
    });

    it.each(cssFiles)('%s spells the phone/desktop edge as (max-width: 767.98px) / (min-width: 768px)', (file) => {
        expect(breakpointViolations(readFileSync(path.join(FRONTEND, file), 'utf8'))).toEqual([]);
    });
});

describe('literal ratchets (may only go down; rerun design-audit.mjs --write after lowering)', () => {
    it('has a baseline', () => {
        expect(baseline && baseline.css).toBeTruthy();
    });

    it.each(cssFiles)('%s does not add colour, z-index or !important literals', (file) => {
        const ceiling = (baseline && baseline.css && baseline.css[file]) || { colourLiterals: 0, zIndexLiterals: 0, important: 0 };
        const actual = now.css[file];
        const over = {};
        ['colourLiterals', 'zIndexLiterals', 'important'].forEach(k => {
            if (actual[k] > ceiling[k]) over[k] = `${actual[k]} > ${ceiling[k]}`;
        });
        expect(over).toEqual({});
    });
});
