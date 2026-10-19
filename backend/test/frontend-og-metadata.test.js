// The tab title and share tags name the product, Consensus Builder (docs/design-language.md). The
// runtime OG script used to overwrite the HTML <title> with the organisation name on every reset, so
// the live tab read "Urban Game Theory" whatever index.html said.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('../../frontend/js/og-metadata.js', import.meta.url), 'utf8');

function boot(htmlTitle) {
    const metas = new Map();
    const meta = key => ({ setAttribute: (attr, value) => { if (attr === 'content') metas.set(key, value); } });
    const document = {
        title: htmlTitle,
        head: { appendChild() {} },
        querySelector: sel => { const key = /="([^"]+)"/.exec(sel)?.[1]; return key ? meta(key) : null; },
        createElement: () => { let key; return { setAttribute: (attr, value) => { if (attr === 'property') key = value; else if (attr === 'content') metas.set(key, value); } }; },
    };
    const window = { document, location: { href: 'https://example.test/?city=zagreb', hostname: 'example.test', protocol: 'https:', host: 'example.test' } };
    window.window = window;
    runInContext(source, createContext(window));
    return { window, document, metas };
}

describe('runtime page title and share tags', () => {
    it('titles a proposal "Proposal · Consensus Builder" and restores the HTML title on reset', () => {
        const { window, document, metas } = boot('Consensus Builder · Free urban planning software');
        window.updateProposalOGMetadata({ title: 'Park · parcel 1234', description: 'A park.' });
        expect(document.title).toBe('Park · parcel 1234 · Consensus Builder');
        expect(metas.get('og:site_name')).toBe('Consensus Builder');
        window.resetOGMetadata();
        expect(document.title).toBe('Consensus Builder · Free urban planning software');
        expect(metas.get('og:title')).toBe('Consensus Builder · Free urban planning software');
        expect(metas.get('og:site_name')).toBe('Consensus Builder');
        expect(JSON.stringify([...metas.values()])).not.toContain('Urban Game Theory');
    });
});
