// Google Photorealistic 3D Tiles attribution text: turns 3d-tiles-renderer's getAttributions()
// list into one plain, deduplicated credit line. Pure (no DOM); photoreal-mode.js renders it next
// to the Google logo, which the Map Tiles API policy requires on screen while the tiles are shown.
(function (global) {
    'use strict';

    // Minimal HTML → text for 'html' attributions (Cesium ion asset credits); we never inject
    // tile-provided markup into the page.
    function htmlToText(html) {
        return String(html)
            .replace(/<[^>]*>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&copy;/g, '©')
            .replace(/\s+/g, ' ')
            .trim();
    }

    // GoogleCloudAuthPlugin reports the per-tile copyrights as one 'string' joined with '; ';
    // split, trim and dedupe so repeated providers show once, in first-seen order. 'image'
    // entries (a logo URL) are skipped: the caller renders the Google logo itself.
    function attributionText(list) {
        const seen = new Set();
        const parts = [];
        (Array.isArray(list) ? list : []).forEach(function (att) {
            if (!att || att.value == null) return;
            let text;
            if (att.type === 'string') text = String(att.value);
            else if (att.type === 'html') text = htmlToText(att.value);
            else return;
            text.split(/;|\n/).forEach(function (piece) {
                const clean = piece.replace(/\s+/g, ' ').trim();
                if (!clean) return;
                const key = clean.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                parts.push(clean);
            });
        });
        return parts.join('; ');
    }

    const api = { attributionText, htmlToText };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    global.PhotorealAttribution = api;
})(typeof window !== 'undefined' ? window : globalThis);
