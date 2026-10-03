// Every page is part of one product (docs/design-language.md): it is titled "Page · Consensus Builder"
// (the landing pages put the product first), it is mobile-ready, and it can get back to the map. Three
// pages used to be dead ends (tx-explorer, actor-explorer, canton) and four were titled under a
// different brand; this keeps that from returning.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FRONTEND } from './helpers/design-audit.mjs';

const pages = readdirSync(FRONTEND).filter(f => f.endsWith('.html')).sort();
const html = Object.fromEntries(pages.map(p => [p, readFileSync(path.join(FRONTEND, p), 'utf8')]));

describe('page chrome', () => {
    it('finds the pages', () => {
        expect(pages.length).toBeGreaterThan(10);
    });

    it.each(pages)('%s is titled under Consensus Builder with the · separator', (page) => {
        const m = html[page].match(/<title>([^<]*)<\/title>/);
        const title = m ? m[1].trim() : '';
        const ok = /^Consensus Builder · /.test(title) || / · Consensus Builder$/.test(title);
        expect({ page, title, ok }).toEqual({ page, title, ok: true });
    });

    it.each(pages)('%s has a viewport meta and a lang attribute', (page) => {
        expect(html[page]).toMatch(/<meta name="viewport"/);
        expect(html[page]).toMatch(/<html[^>]*\slang="/);
    });

    it.each(pages.filter(p => p !== 'index.html'))('%s links back to the map', (page) => {
        const back = /href="(\/|\/index\.html|index\.html)(\?[^"]*)?"/.test(html[page]);
        expect({ page, back }).toEqual({ page, back: true });
    });
});
