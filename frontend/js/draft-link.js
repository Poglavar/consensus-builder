// Unpublished design previews travel in a bounded URL fragment; no pin or index write is involved.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DraftLink = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';
    const MAX_BYTES = 1_000_000, MAX_FRAGMENT = 24_000;
    async function bytes(stream) {
        const reader = stream.getReader(), chunks = []; let size = 0;
        try {
            for (;;) {
                const { value, done } = await reader.read(); if (done) break;
                size += value.byteLength;
                if (size > MAX_BYTES) throw new Error('Draft preview exceeds one megabyte');
                chunks.push(value);
            }
        } finally { await reader.cancel(); }
        const result = new Uint8Array(size); let at = 0;
        for (const chunk of chunks) { result.set(chunk, at); at += chunk.length; }
        return result;
    }
    async function build({ origin, design, parcelSourceId = null }) {
        const raw = new TextEncoder().encode(JSON.stringify({ design, parcelSourceId }));
        if (raw.length > MAX_BYTES) throw new Error('Draft preview exceeds one megabyte');
        const compressed = await bytes(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')));
        const encoded = btoa(Array.from(compressed, n => String.fromCharCode(n)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        if (encoded.length > MAX_FRAGMENT) throw Object.assign(new Error('Draft is too large for a preview URL. Publish it explicitly to get a map link.'), { code: 'preview-too-large', next: { tool: 'ugt_publish_design', arguments: { design, confirm: true } } });
        const url = new URL('/designs', origin);
        if (design.city) url.searchParams.set('city', design.city);
        url.hash = `draft=${encoded}`;
        return url.toString();
    }
    async function parse(hash) {
        const encoded = new URLSearchParams(String(hash).replace(/^#/, '')).get('draft');
        if (!encoded) return null;
        if (encoded.length > MAX_FRAGMENT || !/^[\w-]+$/.test(encoded)) throw new Error('Invalid draft preview');
        const raw = Uint8Array.from(atob(encoded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
        const decoded = await bytes(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip')));
        const result = JSON.parse(new TextDecoder().decode(decoded));
        if (result.design?.schema !== 'design/v1') throw new Error('Preview must carry a design/v1 object');
        return result;
    }
    return { build, parse, MAX_BYTES, MAX_FRAGMENT };
});
