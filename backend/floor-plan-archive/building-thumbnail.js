import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { largestRing, localFrame, storeyPrisms } = require('../../frontend/js/site-model-geometry.js');

const MAX_POLYGONS = 24;
const MAX_RING_POINTS = 192;
const MAX_STOREYS = 80;
const VIEW_WIDTH = 320;
const VIEW_HEIGHT = 180;

function geometryPolygons(footprint) {
    const geometry = normalizedFootprint(footprint);
    if (geometry?.type === 'Polygon') return [geometry.coordinates];
    if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
    return null;
}

function normalizedFootprint(footprint) {
    return footprint?.type === 'Feature' ? footprint.geometry : footprint;
}

function validFootprint(footprint) {
    const polygons = geometryPolygons(footprint);
    if (!polygons?.length || polygons.length > MAX_POLYGONS) return false;
    let pointCount = 0;
    for (const polygon of polygons) {
        const ring = polygon?.[0];
        if (!Array.isArray(ring) || ring.length < 4) return false;
        pointCount += ring.length;
        if (pointCount > MAX_RING_POINTS) return false;
        for (const point of ring) {
            if (!Array.isArray(point) || point.length < 2) return false;
            const [lng, lat] = point;
            if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) return false;
        }
    }
    return Boolean(largestRing(normalizedFootprint(footprint)));
}

function validStoreys(storeys) {
    return Array.isArray(storeys) && storeys.length > 0 && storeys.length <= MAX_STOREYS
        && storeys.every(storey => Number.isFinite(storey?.elevationM)
            && Number.isFinite(storey?.heightM) && storey.heightM > 0
            && storey.heightM <= 100 && Math.abs(storey.elevationM) <= 1000
            && Number.isFinite(storey.elevationM + storey.heightM)
            && Math.abs(storey.elevationM + storey.heightM) <= 1100);
}

function fmt(value) {
    return Number(value.toFixed(2)).toString();
}

function path(points) {
    return points.map((point, i) => `${i ? 'L' : 'M'}${fmt(point[0])} ${fmt(point[1])}`).join(' ') + ' Z';
}

function buildingThumbnailSvg(model) {
    const footprint = model?.envelope?.footprint;
    const storeys = model?.envelope?.storeys;
    if (!validFootprint(footprint) || !validStoreys(storeys)) return null;

    const geometry = normalizedFootprint(footprint);
    const frame = localFrame({ envelope: { footprint: geometry } });
    const prisms = storeyPrisms({ envelope: { footprint: geometry, storeys } });
    if (!frame || prisms.length !== storeys.length || !prisms.length) return null;
    const ring = prisms[0].ring;
    if (ring.length < 3 || ring.some(point => !point.every(Number.isFinite))) return null;

    const allZ = prisms.flatMap(prism => [prism.z0, prism.z1]);
    if (allZ.some(z => !Number.isFinite(z))) return null;
    const projected = (x, y, z) => [x - y, (x + y) * 0.5 - z * 0.78];
    const rawPoints = ring.flatMap(([x, y]) => allZ.flatMap(z => [projected(x, y, z), projected(x, y, 0)]));
    const minX = Math.min(...rawPoints.map(p => p[0]));
    const maxX = Math.max(...rawPoints.map(p => p[0]));
    const minY = Math.min(...rawPoints.map(p => p[1]));
    const maxY = Math.max(...rawPoints.map(p => p[1]));
    const width = maxX - minX;
    const height = maxY - minY;
    if (![minX, maxX, minY, maxY, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    const scale = Math.min(230 / width, 132 / height);
    const offsetX = 160 - (minX + maxX) * scale / 2;
    const offsetY = 92 - (minY + maxY) * scale / 2;
    const place = ([x, y]) => [x * scale + offsetX, y * scale + offsetY];
    const worldAt = (z) => ring.map(([x, y]) => place(projected(x, y, z)));

    const elements = [];
    const ground = worldAt(0);
    elements.push(`<path d="${path(ground.map(([x, y]) => [x + 5, y + 7]))}" fill="#453d35" opacity=".10"/>`);

    for (const prism of [...prisms].sort((a, b) => a.z0 - b.z0)) {
        const lower = worldAt(prism.z0);
        const upper = worldAt(prism.z1);
        const faces = ring.map((_, i) => {
            const next = (i + 1) % ring.length;
            const points = [lower[i], lower[next], upper[next], upper[i]];
            const depth = (lower[i][1] + lower[next][1] + upper[i][1] + upper[next][1]) / 4;
            const dx = upper[next][0] - upper[i][0];
            const shade = dx >= 0 ? '#c58a62' : '#a96e4b';
            return { points, depth, shade };
        }).sort((a, b) => a.depth - b.depth);
        for (const face of faces) elements.push(`<path d="${path(face.points)}" fill="${face.shade}" stroke="#8e5c43" stroke-width=".7" stroke-linejoin="round"/>`);
        elements.push(`<path d="${path(upper)}" fill="#e5b58c" stroke="#9b684d" stroke-width=".85" stroke-linejoin="round"/>`);
    }

    const count = prisms.length;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW_WIDTH}" height="${VIEW_HEIGHT}" viewBox="0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}" role="img" aria-labelledby="building-thumbnail-title"><title id="building-thumbnail-title">3D obris zgrade</title><desc>Broj etaža: ${count}</desc><rect width="320" height="180" rx="12" fill="#f4eee7"/><ellipse cx="160" cy="139" rx="111" ry="22" fill="#d9cbbb" opacity=".26"/>${elements.join('')}</svg>`;
}

export { buildingThumbnailSvg };
