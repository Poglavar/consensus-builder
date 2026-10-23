import { describe, expect, it } from 'vitest';
import { createPreviewLinks } from '../agents/mcp-preview-links.js';

describe('temporary hosted MCP preview links', () => {
    it('keeps canonical objects unchanged and shortens every comparison alternative', () => {
        const store = createPreviewLinks({ origin: 'https://mcp.example', appOrigin: 'https://app.example' });
        const design = { schema: 'design/v1', previewUrl: 'canonical data, not transport metadata' };
        const target = 'https://app.example/designs?city=london#draft=encoded';
        const result = store.decorate({ design, alternatives: [{ cid: 'same', previewUrl: target }, { previewUrl: target }] });
        expect(result.design).toBe(design);
        expect(result.alternatives[0].previewStatus).toBe('private-link');
        const url = new URL(result.alternatives[0].previewUrl);
        expect(url.pathname).toMatch(/^\/mcp\/previews\/[\w-]{32}$/);
        expect(store.get(url.pathname.split('/').at(-1))).toBe(target);
        expect(result.alternatives[1].previewUrl).toBe(url.href);
        expect(store.get('guessed-token')).toBeNull();
        expect(store.decorate({ previewUrl: 'https://other.example/designs#draft=encoded' }).previewUrl).toContain('other.example');
    });
    it('expires, bounds and clears private state without publication', () => {
        let now = 0;
        const store = createPreviewLinks({ origin: 'http://127.0.0.1:3096', appOrigin: 'https://app.example', ttlMs: 100, maxEntries: 1, now: () => now });
        const add = value => new URL(store.decorate({ previewUrl: `https://app.example/designs#draft=${value}` }).previewUrl).pathname.split('/').at(-1);
        const first = add('first'), second = add('second');
        expect(store.get(first)).toBeNull();
        expect(store.get(second)).toContain('second');
        now = 100; expect(store.get(second)).toBeNull();
        const third = add('third'); store.clear(); expect(store.get(third)).toBeNull();
        expect(() => createPreviewLinks({ origin: 'http://public.example', appOrigin: 'https://app.example' })).toThrow(/HTTPS/);
    });
});
