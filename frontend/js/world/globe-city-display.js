// Pure, screen-space city detail for the globe: population priority, bounded dots and labels.
// The renderer projects this catalog; neither the DOM budget nor point budget grows with it.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.WorldCityDisplay = api;
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_LABELS = 18;
    const MAX_MARKERS = 240;
    const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
    const population = city => typeof city.population2025 === 'number' && Number.isFinite(city.population2025)
        && city.population2025 > 0 ? city.population2025 : null;

    // Rank once, before camera movement. Missing populations remain unknown, never invented.
    function rankCities(coverage) {
        return coverage.liveCities.map(city => ({ key: 'live:' + city.id, city, live: true, population: population(city) }))
            .concat(coverage.cities.map(city => ({ key: 'research:' + city.id, city, live: false, population: population(city) })))
            .sort((a, b) => Number(b.live) - Number(a.live)
                || (b.population || 0) - (a.population || 0) || a.key.localeCompare(b.key));
    }

    function detailFor({ width, height, altitudeKm, fov = 40 }) {
        const kmPerPixel = 2 * altitudeKm * Math.tan(fov * Math.PI / 360) / Math.max(1, height);
        const detail = clamp(Math.log2(14 / Math.max(0.01, kmPerPixel)), 0, 4);
        const phone = width < 768;
        return {
            detail,
            labelLimit: Math.min(MAX_LABELS, Math.round((phone ? 4 : 7) + detail * (phone ? 1.5 : 2.5))),
            markerLimit: Math.min(MAX_MARKERS, Math.round(clamp(width * height / 7000, 40, 140) * (1 + detail * 0.18))),
            markerSpacing: 14 - detail * 1.5,
            minimumPopulation: 2000000 / Math.pow(4, detail),
            showUnknownLabels: detail >= 1.5,
            showResearch: detail >= 1,
            labelGap: phone ? 10 : 14
        };
    }

    function overlaps(a, b, gap = 0) {
        return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap
            && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
    }

    function canPlace(box, viewport, occupied, gap = 4) {
        return box.x >= 10 && box.y >= 10 && box.x + box.w <= viewport.width - 10
            && box.y + box.h <= viewport.height - 10 && !occupied.some(other => overlaps(box, other, gap));
    }

    // Candidates retain rankCities order and carry {entry,x,y,labelWidth,labelHeight}; back-side
    // points have already been culled by the renderer. The selected/focused city goes first.
    function layout(candidates, viewport, { blocked = [], pinnedKeys = [] } = {}) {
        const detail = detailFor(viewport);
        const pinned = new Set(pinnedKeys);
        const ordered = candidates.filter(candidate => pinned.has(candidate.entry.key))
            .concat(candidates.filter(candidate => !pinned.has(candidate.entry.key)));
        const markers = [];
        const cells = new Map();
        const spacing = detail.markerSpacing;
        for (const candidate of ordered) {
            const { entry, x, y } = candidate;
            if (!entry.live && !detail.showResearch && !pinned.has(entry.key)) continue;
            if (x < 8 || y < 8 || x > viewport.width - 8 || y > viewport.height - 8) continue;
            if (blocked.some(box => x >= box.x - 4 && x <= box.x + box.w + 4
                && y >= box.y - 4 && y <= box.y + box.h + 4)) continue;
            const gx = Math.floor(x / spacing); const gy = Math.floor(y / spacing);
            let crowded = false;
            for (let dx = -1; dx <= 1 && !crowded; dx++) for (let dy = -1; dy <= 1 && !crowded; dy++) {
                const neighbors = cells.get((gx + dx) + ',' + (gy + dy)) || [];
                crowded = neighbors.some(other => (x - other.x) ** 2 + (y - other.y) ** 2 < spacing ** 2);
            }
            if (crowded) continue;
            const marker = { ...candidate, glow: pinned.has(entry.key), size: entry.live ? 4.5 : 3,
                opacity: entry.live ? 0.65 : 0.3 };
            markers.push(marker);
            const key = gx + ',' + gy;
            if (!cells.has(key)) cells.set(key, []);
            cells.get(key).push(marker);
            if (markers.length >= detail.markerLimit) break;
        }

        const labels = [];
        const occupied = blocked.slice();
        for (const marker of markers) {
            const { entry, x, y, labelWidth: w, labelHeight: h } = marker;
            if (!entry.live || !(w > 0 && h > 0)) continue;
            if (!pinned.has(entry.key) && (entry.population === null
                ? !detail.showUnknownLabels : entry.population < detail.minimumPopulation)) continue;
            const positions = [
                { x: x + 9, y: y - h / 2, w, h },
                { x: x - w - 9, y: y - h / 2, w, h }
            ];
            const box = positions.find(position => canPlace(position, viewport, occupied, detail.labelGap));
            if (!box) continue;
            occupied.push(box);
            labels.push({ entry, x: box.x, y: box.y, w, h, offsetX: box.x - x, offsetY: box.y - y });
            marker.glow = true;
            if (labels.length >= detail.labelLimit) break;
        }
        for (const marker of markers) {
            if (marker.glow) { marker.size = 11; marker.opacity = 1; }
        }
        return { markers, labels, detail };
    }

    return { MAX_LABELS, MAX_MARKERS, rankCities, detailFor, layout, canPlace };
});
