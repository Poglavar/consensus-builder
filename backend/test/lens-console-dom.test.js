// Characterizes the real console wiring: a posted verdict refreshes observed counts and attestations.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const LensCore = require('../../frontend/js/lens-core.js');
const source = readFileSync(new URL('../../frontend/js/lens-console.js', import.meta.url), 'utf8');
const KEY = LensCore.base58Encode(Uint8Array.from({ length: 32 }, () => 7));

class Node {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.listeners = {};
        this.attributes = {};
        this.value = '';
        this.disabled = false;
        this.className = '';
    }
    append(...children) { this.children.push(...children); }
    prepend(child) { this.children.unshift(child); }
    replaceChildren(...children) { this.children = children; }
    replaceWith(node) { this.replacedWith = node; }
    addEventListener(type, handler) { this.listeners[type] = handler; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    get lastChild() { return this.children.at(-1); }
    get textContent() { return this.children.map(child => child?.textContent || '').join(''); }
    set textContent(value) { this.children = [{ textContent: String(value) }]; }
}

function boot({ postOutcome = 'ok' } = {}) {
    const ids = [
        'lc-language', 'lc-run-own', 'lc-service-url', 'lc-directory', 'lc-service-load',
        'lc-attestations-load', 'lc-wallet-connect', 'lc-verdict-form', 'lc-wallet',
        'lc-filter-kind', 'lc-filter-parcel', 'lc-verdict-result', 'lc-verdict-token',
        'lc-verdict-proposal', 'lc-verdict-kind', 'lc-verdict-evidence', 'lc-verdict-observed',
        'lc-status', 'lc-attestations'
    ];
    const nodes = Object.fromEntries(ids.map(id => [id, new Node()]));
    nodes['lc-service-url'].value = 'https://member.example';
    nodes['lc-verdict-token'].value = 'operator-token';
    nodes['lc-verdict-proposal'].value = KEY;
    nodes['lc-verdict-kind'].value = 'executed';
    nodes['lc-verdict-observed'].value = '2026-10-05T12:00:00Z';
    let statusReads = 0;
    let attestationReads = 0;
    const client = {
        async fetchDirectory() { return { outcome: { kind: 'ok' }, members: [] }; },
        async fetchStatus() {
            statusReads += 1;
            return { outcome: { kind: 'ok' }, body: { key: KEY, kind: 'court', counts: { executed: statusReads - 1 } } };
        },
        async fetchAttestations() {
            attestationReads += 1;
            return { outcome: { kind: 'ok' }, attestations: attestationReads === 1 ? [] : [{ kind: 'executed', address: KEY }] };
        },
        async postVerdict() {
            return postOutcome === 'ok'
                ? { outcome: { kind: 'ok' }, body: { address: KEY, accountHash: 'after' } }
                : { outcome: { kind: 'error', status: 500, message: 'refused' } };
        }
    };
    const document = {
        readyState: 'complete',
        createElement(tag) { return new Node(tag); },
        getElementById(id) { return nodes[id]; },
        addEventListener() {}
    };
    const window = {
        document,
        LensCore,
        LensServiceClient: client,
        location: { search: '' },
        localStorage: { getItem() { return null; }, setItem() {} },
        getBackendBase() { return 'https://api.example'; },
        addEventListener() {}
    };
    vm.runInNewContext(source, { window, URLSearchParams, console });
    return { nodes, reads: () => ({ statusReads, attestationReads }) };
}

describe('lens console verdict wiring', () => {
    it('redraws issued counts and attestations after a successful verdict', async () => {
        const page = boot();
        page.nodes['lc-service-url'].value = 'https://member.example';
        await page.nodes['lc-service-load'].listeners.click();
        await page.nodes['lc-verdict-form'].listeners.submit({ preventDefault() {} });

        expect(page.reads()).toEqual({ statusReads: 2, attestationReads: 2 });
        expect(page.nodes['lc-status'].textContent).toContain('executed: 1');
        expect(page.nodes['lc-attestations'].textContent).toContain('executed');
    });

    it('does not refresh either display when the verdict request fails', async () => {
        const page = boot({ postOutcome: 'error' });
        page.nodes['lc-service-url'].value = 'https://member.example';
        await page.nodes['lc-service-load'].listeners.click();
        await page.nodes['lc-verdict-form'].listeners.submit({ preventDefault() {} });

        expect(page.reads()).toEqual({ statusReads: 1, attestationReads: 1 });
        expect(page.nodes['lc-verdict-result'].textContent).toContain('refused');
    });
});
