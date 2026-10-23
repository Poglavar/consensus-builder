// An isolated node host for the browser's formation handlers. Only presentation/storage effects
// are ports; parcel identity, clipping, precedence, provenance and ground derivation stay in the app.
import { createContext, runInContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { installAppGeometry } from './mcp-geometry.js';

const root = new URL('../../frontend/js/', import.meta.url);
const scripts = [
    'cid.js', 'agreement-record.js', 'agreement-ground.js', 'work-slicer.js', 'proposals/apply/route.js', 'proposals/parcel-contiguity.js',
    'proposals/footprint-parts.js', 'proposals/parcel-arrangement.js', 'proposals/plan-order.js', 'proposals/formation-edit.js',
    'parcel-layout-validation.js', 'parcel-layout-record.js', 'parcel-layout-ownership.js',
    'parcels/live-fabric.js', 'proposals/apply/road.js', 'proposals/apply/buildings.js', 'proposals/apply/structures.js', 'proposals/apply/parcels.js'
].map(path => ({ path, source: readFileSync(new URL(path, root), 'utf8'), require: createRequire(new URL(path, root)) }));
const classic = ['proposal-parcel-identity.js', 'proposal-road-geometry.js', 'proposals/apply/finalize.js', 'proposal-manager.js', 'agreement-headless.js']
    .map(path => ({ path, source: readFileSync(new URL(path, root), 'utf8') }));

export async function deriveWithApp({ designs, parcels, ownerOf = () => [] }) {
    const logger = Object.fromEntries(['log', 'debug', 'info', 'warn', 'error'].map(level => [level, (...args) => console.error(`[${new Date().toISOString()}] [mcp-ground]`, ...args)]));
    const ctx = createContext({ console: logger, structuredClone, performance, URL, TextEncoder, Uint8Array, Buffer });
    installAppGeometry(ctx);
    ctx.window = ctx;
    ctx.require = createRequire(new URL('proposal-manager.js', root));
    for (const script of scripts) {
        ctx.__moduleRequire = script.require;
        runInContext(`(function(require) {\n${script.source}\n})(__moduleRequire);`, ctx, { filename: script.path, timeout: 10_000 });
    }
    for (const script of classic) {
        ctx.require = createRequire(new URL(script.path, root));
        runInContext(script.source, ctx, { filename: script.path, timeout: 10_000 });
    }
    return ctx.AgreementHeadless.derive({ designs, parcels, ownerOf });
}
