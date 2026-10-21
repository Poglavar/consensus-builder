// Shared by the Candlestick Point importers (import-candlestick-courtyard.mjs and
// import-candlestick-fivepoint.mjs): publish each ordinary Freeform building on its own footprint
// through the normal API (site binding first, then the proposal).
// Restarts verify stored content before skipping a record, so source edits require a new version.

export const DEFAULTS = Object.freeze({
    backend: 'http://localhost:4650',
    origin: 'http://localhost:5650',
    city: 'san_francisco',
    parcelSourceId: 'us-ca-sf-datasf-active-parcels',
    expiresInDays: 365
});

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

export function bboxOf(features) {
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    for (const feature of features) {
        const rings = feature.geometry.type === 'Polygon' ? feature.geometry.coordinates : feature.geometry.coordinates.flat();
        for (const ring of rings) {
            for (const [lon, lat] of ring) {
                box[0] = Math.min(box[0], lon); box[1] = Math.min(box[1], lat);
                box[2] = Math.max(box[2], lon); box[3] = Math.max(box[3], lat);
            }
        }
    }
    return box.map(value => Number(value.toFixed(5)));
}

export async function request(backend, origin, method, route, body) {
    const response = await fetch(`${backend}${route}`, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { status: response.status, json, text };
}

/**
 * Publish a converted record: skip when its proposalId already exists, otherwise prepare it
 * (POST /proposals/prepare: the server builds a corridor's land, binds the site against the city's
 * parcel source and signs the artifact) and POST exactly the record the preparation returns — it
 * carries the signed preparation and the artifact, which publication verifies and stores.
 */
function stable(value) {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
}

export async function publish(record, { backend, origin, city, parcelSourceId = DEFAULTS.parcelSourceId, requestFn = request }) {
    const existing = await requestFn(backend, origin, 'GET', `/proposals/${encodeURIComponent(record.proposalId)}`);
    if (existing.status === 200) {
        const current = existing.json?.proposal || existing.json;
        const expectedTypology = record.buildingProposal?.typologyType || record.typologyType;
        const currentTypology = current?.buildingProposal?.typologyType || current?.typologyType;
        const same = current?.goal === record.goal && currentTypology === expectedTypology
            && stable(current?.geometry?.buildings) === stable(record.geometry?.buildings);
        if (!same) throw new Error(`proposal ${record.proposalId} exists with different Freeform content; choose a new proposal-id prefix/version`);
        log(`proposal ${record.proposalId} already exists on ${backend} (row ${current.id}); leaving it alone`);
        return { skipped: true, id: current.id };
    }
    if (existing.status !== 404) throw new Error(`proposal lookup failed (${existing.status}): ${existing.text.slice(0, 300)}`);
    log(`preparing against ${parcelSourceId}…`);
    const prepared = await requestFn(backend, origin, 'POST', '/proposals/prepare', {
        proposal: record, city, parcelSourceId, toleranceM: record.toleranceM
    });
    if (prepared.status !== 201 || !prepared.json || !prepared.json.proposal || !prepared.json.artifact) {
        throw new Error(`preparation failed (${prepared.status}): ${prepared.text.slice(0, 300)}`);
    }
    const { artifact, preparationId } = prepared.json;
    const binding = artifact.binding;
    const parcelIds = artifact.cadastreParcelIds || [];
    log(`prepared ${preparationId}: binds ${parcelIds.length} parcels (coverage ${binding.coverage}, unsurveyed ${Math.round(binding.unsurveyedM2 || 0)} m², ${prepared.json.queryMs} ms)${artifact.corridor ? ', corridor land built by the server' : ''}`);
    const body = { ...prepared.json.proposal, parcelSourceId };
    const created = await requestFn(backend, origin, 'POST', '/proposals', body);
    if (created.status < 200 || created.status >= 300) {
        throw new Error(`create failed (${created.status}): ${created.text.slice(0, 500)}`);
    }
    const id = created.json && (created.json.id ?? created.json.proposal?.id);
    const readback = await requestFn(backend, origin, 'GET', `/proposals/${encodeURIComponent(record.proposalId)}`);
    const stored = readback.json?.proposal || readback.json;
    if (readback.status !== 200 || stable(stored?.geometry?.buildings) !== stable(record.geometry?.buildings)
        || stored?.goal !== record.goal || stored?.typologyType !== record.typologyType) {
        throw new Error(`Stored proposal ${record.proposalId} failed Freeform geometry readback verification.`);
    }
    log(`created proposal ${record.proposalId} (row ${id}) with ${parcelIds.length} parcels`);
    // The server returns the edit token exactly once; hand it back so the caller can keep it.
    return { skipped: false, id, parcelIds, preparationId, editToken: (created.json && created.json.editToken) || null };
}
