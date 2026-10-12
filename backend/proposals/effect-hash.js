// The effect hash a stored record is stamped with: the fingerprint of goal + footprint + ownership
// flow that owner consent binds to, from frontend/js/proposals/ownership-flow.js — the same module
// the browser runs, so the server's stamp and a browser's own computation agree. Computed here from
// the stored fields so the stamp is the server's, never the uploader's, and so a reader never has
// to union the footprint again: a plan of 1,105 buildings takes seconds to union, and the details
// panel asked for it once per listed parcel (2026-10-12).
//
// A readjustment hashes its complete deal (reparcellization-deal.js) and throws when the deal is
// invalid; the publish route refuses those before it gets here. Null when the hash cannot be
// computed on the server: a record without a footprint (content-only — the browser falls back to
// the content fingerprint), or a legacy centre-line road, whose corridor only the browser's corridor
// builder rebuilds. The browser derives those live, as before.
import { createRequire } from 'node:module';
import { footprintParts } from './footprint.js';

const requireCjs = createRequire(import.meta.url);
// plan-order.js reads turf from the runtime global (window.turf in the browser) and falls back to a
// require that resolves from the frontend tree, where no node_modules exist; the backend's copy is
// supplied the way the tests and repair scripts do.
if (typeof globalThis.turf === 'undefined') globalThis.turf = requireCjs('@turf/turf');
const ownershipFlow = requireCjs('../../frontend/js/proposals/ownership-flow.js');

export function effectHashOf(proposal) {
    if (!proposal || typeof proposal !== 'object') return null;
    // A stamp already on the input must not be echoed back: the value is always recomputed.
    const { effectHash: _stamped, ...record } = proposal;
    const readjustment = !!record.reparcellization || record.goal === 'reparcellization';
    if (!readjustment) {
        const parts = footprintParts(record);
        if (parts.invalid || parts.centerline || !parts.polygons.length) return null;
    }
    const hash = ownershipFlow.effectFingerprintOf(record);
    return typeof hash === 'string' && hash ? hash : null;
}
