// Svaki CSS mora imati uravnotežene vitičaste zagrade.
//
// Zašto test: nedostajuća `}` NE ruši ništa glasno — preglednik samo prestane
// parsirati taj file na tom mjestu i sva pravila IZA nestanu. Točno se to
// dogodilo pri razrješavanju merge konflikta u modals.css: pojedena zatvorena
// zagrada u `.proposal-epoch-select` progutala je i epoch bulk traku i tuđe
// `.reparcel-node-popup__consequence` stilove. Stranica se i dalje učitavala,
// testovi su bili zeleni, a dva sloja UI-a su bila nevidljivo neostilizirana.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const CSS_DIR = join(import.meta.dirname, '..', '..', 'frontend', 'css');

/** Broji zagrade izvan komentara i stringova — inače `content: "}"` laže. */
function countBraces(css) {
    let otvorene = 0, zatvorene = 0;
    let uKomentaru = false, uStringu = null;
    for (let i = 0; i < css.length; i++) {
        const c = css[i], sljedeci = css[i + 1];
        if (uKomentaru) {
            if (c === '*' && sljedeci === '/') { uKomentaru = false; i++; }
            continue;
        }
        if (uStringu) {
            if (c === '\\') { i++; continue; }
            if (c === uStringu) uStringu = null;
            continue;
        }
        if (c === '/' && sljedeci === '*') { uKomentaru = true; i++; continue; }
        if (c === '"' || c === "'") { uStringu = c; continue; }
        if (c === '{') otvorene++;
        else if (c === '}') zatvorene++;
    }
    return { otvorene, zatvorene };
}

const cssFiles = readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));

describe('CSS structure', () => {
    it('finds stylesheets to check', () => {
        expect(cssFiles.length).toBeGreaterThan(0);
    });

    it.each(cssFiles)('%s has balanced braces', (file) => {
        const { otvorene, zatvorene } = countBraces(readFileSync(join(CSS_DIR, file), 'utf8'));
        expect({ file, otvorene, zatvorene }).toEqual({ file, otvorene, zatvorene: otvorene });
    });

    it.each(cssFiles)('%s has no leftover merge conflict markers', (file) => {
        const css = readFileSync(join(CSS_DIR, file), 'utf8');
        expect(css).not.toMatch(/^(<<<<<<<|=======|>>>>>>>)/m);
    });
});

describe('countBraces ignores braces in comments and strings', () => {
    it('does not count a brace inside a comment', () => {
        expect(countBraces('a { color: red; } /* } */')).toEqual({ otvorene: 1, zatvorene: 1 });
    });

    it('does not count a brace inside content quotes', () => {
        expect(countBraces('a::after { content: "}"; }')).toEqual({ otvorene: 1, zatvorene: 1 });
    });

    it('does catch a genuinely missing brace', () => {
        expect(countBraces('a { color: red; b { color: blue; }')).toEqual({ otvorene: 2, zatvorene: 1 });
    });
});
