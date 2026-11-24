// Orthographic snapshots of the published design. Both sides use the same metric projection,
// crop and light. The scene uses mapped building stock and the authored intervention.
import { createCanvas } from 'canvas';
import { buildAgreementScene } from './agreement-scene.js';

const WIDTH = 640, HEIGHT = 384;
const AZIMUTH = Math.PI / 4, ELEVATION = 32 * Math.PI / 180;
const SIN_A = Math.sin(AZIMUTH), COS_A = Math.cos(AZIMUTH);
const SIN_E = Math.sin(ELEVATION), COS_E = Math.cos(ELEVATION);
const EXISTING = { roof: '#d5dcd7', wall: [177, 190, 183], edge: '#768a80', joint: '#a0afa6' };
const PROPOSED = { roof: '#e9a675', wall: [204, 137, 99], edge: '#845840', joint: '#925e43' };
const GROUND = { park: '#b6cc9c', green: '#b6cc9c', square: '#d4ccc0', paved: '#ddd7cb', lake: '#9ac4cf', station: '#cec6b8',
    road: '#b6b7b1', 'road-track': '#b6b7b1', 'parcel-layout': '#e5dfc8' };

function ringsOf(geometry) {
    if (geometry.type === 'Polygon') return [geometry.coordinates];
    if (geometry.type === 'MultiPolygon') return geometry.coordinates;
    return [];
}

function makeCamera(scene) {
    const [west, south, east, north] = scene.bounds;
    const lng = (east + west) / 2, lat = (north + south) / 2;
    const metresLon = 111320 * Math.cos(lat * Math.PI / 180);
    function project([lon, latitude], height = 0) {
        const x = (lon - lng) * metresLon, y = (latitude - lat) * 110574;
        const depth = x * SIN_A + y * COS_A;
        return { u: x * COS_A - y * SIN_A, v: -depth * SIN_E - height * COS_E, depth };
    }
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
    function include(point, height) {
        const { u, v } = project(point, height);
        left = Math.min(left, u); right = Math.max(right, u);
        top = Math.min(top, v); bottom = Math.max(bottom, v);
    }
    function fit(geometry, height) {
        for (const polygon of ringsOf(geometry)) {
            for (const point of polygon[0]) { include(point, 0); if (height > 0) include(point, height); }
        }
    }
    for (const site of scene.sites) fit(site, 0);
    for (const piece of scene.surfaces) fit(piece.geometry, 0);
    for (const block of scene.proposed) fit(block.geometry, block.height);
    // A tall building to be cleared must fit the Before frame too. Neighbours outside the
    // subject give context at the edges; they must not zoom a small proposal out of view.
    for (const block of scene.before) {
        for (const polygon of ringsOf(block.geometry)) {
            for (const point of polygon[0]) {
                if (point[0] >= west && point[0] <= east && point[1] >= south && point[1] <= north) include(point, block.height || 0);
            }
        }
    }
    const scale = Math.min(WIDTH * .76 / Math.max(right - left, 6), HEIGHT * .68 / Math.max(bottom - top, 6));
    const cx = (right + left) / 2, cy = (top + bottom) / 2;
    const screen = (point, z = 0) => {
        const { u, v } = project(point, z);
        return [WIDTH / 2 + (u - cx) * scale, HEIGHT * .48 + (v - cy) * scale];
    };
    return { screen, project, scale };
}

function path(ctx, rings, project) {
    ctx.beginPath();
    for (const ring of rings) {
        if (ring.length < 3) continue;
        ctx.moveTo(...project(ring[0]));
        for (let i = 1; i < ring.length; i++) ctx.lineTo(...project(ring[i]));
        ctx.closePath();
    }
}

function surface(ctx, camera, geometry, fill, stroke) {
    for (const rings of ringsOf(geometry)) {
        path(ctx, rings, p => camera.screen(p));
        ctx.fillStyle = fill; ctx.fill('evenodd');
        if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
    }
}

// Ground depth orders the prisms. Ring normals select visible walls, including the inside of
// courtyards. Each floor line is placed at its authored fraction of the real building height.
function drawPrism(ctx, camera, { rings, height, floors, material }) {
    const { screen, project } = camera;
    const walls = [];
    for (const [ringIndex, points] of rings.entries()) {
        const base = points.map(p => project(p));
        // Use local metres for the winding test so a small house at a large longitude retains precision.
        let winding = 0;
        for (let i = 1; i < base.length; i++) winding += base[i-1].u * base[i].depth - base[i].u * base[i-1].depth;
        const normalSign = (ringIndex ? -1 : 1) * Math.sign(winding);
        for (let i = 1; i < points.length; i++) {
            const du = (base[i].u - base[i-1].u) * normalSign;
            if (du <= 0 || !(height > 0)) continue;
            const dd = (base[i].depth - base[i-1].depth) * normalSign;
            walls.push({ a: points[i-1], b: points[i], depth: (base[i].depth + base[i-1].depth) / 2,
                light: .90 - .18 * dd / Math.hypot(du, dd) });
        }
    }
    walls.sort((a, b) => b.depth - a.depth);
    for (const wall of walls) {
        const { a, b, light } = wall;
        const corners = [screen(a), screen(b), screen(b, height), screen(a, height)];
        path(ctx, [corners], p => p);
        ctx.fillStyle = 'rgb(' + material.wall.map(v => Math.round(v * light)).join(',') + ')';
        ctx.fill(); ctx.strokeStyle = material.edge; ctx.lineWidth = .9; ctx.stroke();
        // At thumbnail scale, closely spaced floors would merge into an opaque dark wall.
        if (floors > 1 && height * COS_E * camera.scale / floors >= 3) {
            ctx.beginPath();
            for (let level = 1; level < floors; level++) {
                const z = height * level / floors;
                ctx.moveTo(...screen(a, z)); ctx.lineTo(...screen(b, z));
            }
            ctx.strokeStyle = material.joint; ctx.lineWidth = .75; ctx.stroke();
        }
    }
    path(ctx, rings, p => screen(p, height));
    ctx.fillStyle = material.roof; ctx.fill('evenodd');
    ctx.strokeStyle = material.edge; ctx.lineWidth = 1.1; ctx.stroke();
}

function drawView(scene, camera, after) {
    const canvas = createCanvas(WIDTH, HEIGHT), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#e9ede6'; ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.lineWidth = 1;
    for (const site of scene.sites) surface(ctx, camera, site, '#f5f0e0', '#99a18d');
    if (after) for (const piece of scene.surfaces) surface(ctx, camera, piece.geometry, GROUND[piece.kind] || '#ddd6be', '#989d8e');
    const blocks = [];
    function add(list, material) {
        for (const { geometry, height, floors } of list) {
            for (const rings of ringsOf(geometry)) {
                const ring = rings[0];
                if (!ring || ring.length < 4) continue;
                const depth = ring.reduce((sum, p) => sum + camera.project(p).depth, 0) / ring.length;
                blocks.push({ rings, depth, material, height: height || 0, floors });
            }
        }
    }
    add(after ? scene.retained : scene.before, EXISTING);
    if (after) add(scene.proposed, PROPOSED);
    // A restrained cast shadow grounds the volumes without adding invented facade details.
    ctx.fillStyle = 'rgba(69,78,63,.13)';
    for (const { rings, height } of blocks) {
        if (!(height > 0)) continue;
        path(ctx, rings, p => { const [x,y] = camera.screen(p); return [x + height * camera.scale * .27, y - height * camera.scale * .12]; });
        ctx.fill('evenodd');
    }
    blocks.sort((a, b) => b.depth - a.depth);
    for (const block of blocks) drawPrism(ctx, camera, block);
    const maxMetres = 82 / camera.scale, base = 10 ** Math.floor(Math.log10(maxMetres));
    const metres = ([5, 2, 1].find(factor => base * factor <= maxMetres) || 1) * base;
    // The divider's translated Before/After labels occupy the lower corners.
    const x = WIDTH - 17, y = 33, length = metres * camera.scale;
    ctx.fillStyle = '#f5f6efd9'; ctx.fillRect(x - length - 8, y - 20, length + 16, 28);
    ctx.strokeStyle = ctx.fillStyle = '#4b584e'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(x - length, y - 3); ctx.lineTo(x - length, y); ctx.lineTo(x, y); ctx.lineTo(x, y - 3); ctx.stroke();
    ctx.font = '12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(metres + ' m', x - length / 2, y - 6);
    return canvas;
}

export function renderAgreementViews(scene) {
    const camera = makeCamera(scene), after = drawView(scene, camera, true);
    const afterPng = after.toBuffer('image/png');
    if (!scene.baselineComplete) return { after: afterPng, before: null, pair: null, baselineComplete: false };
    const before = drawView(scene, camera, false), pair = createCanvas(WIDTH * 2, HEIGHT);
    const ctx = pair.getContext('2d');
    ctx.drawImage(before, 0, 0); ctx.drawImage(after, WIDTH, 0);
    return { after: afterPng, before: before.toBuffer('image/png'), pair: pair.toBuffer('image/png'), baselineComplete: true };
}

export async function renderAgreementModel(pool, subject) {
    const scene = await buildAgreementScene(pool, subject);
    return scene ? renderAgreementViews(scene) : null;
}
