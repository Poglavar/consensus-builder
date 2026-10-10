// Shared by the Candlestick Point importers (import-candlestick-courtyard.mjs and
// import-candlestick-fivepoint.mjs): the site from the DataSF boundary, growing it around footprints
// that cross it by centimetres, and publishing a converted record through the normal API (the site
// binding first, then the proposal) so every server rule applies exactly as it does for a browser.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as turf from '@turf/turf';

export const DEFAULTS = Object.freeze({
    backend: 'http://localhost:4650',
    origin: 'http://localhost:5650',
    city: 'san_francisco',
    parcelSourceId: 'us-ca-sf-datasf-active-parcels',
    boundary: path.join(path.dirname(fileURLToPath(import.meta.url)), '../data/candlestick/candlestick-point-boundary-wgs84.geojson'),
    expiresInDays: 365
});

const log = (message) => console.log(`[${new Date().toISOString()}] ${message}`);

export function siteFromBoundary(boundaryGeoJson) {
    const feature = boundaryGeoJson.type === 'FeatureCollection' ? boundaryGeoJson.features[0] : boundaryGeoJson;
    const geometry = feature.geometry || feature;
    if (geometry.type === 'Polygon') return { type: 'MultiPolygon', coordinates: [geometry.coordinates] };
    if (geometry.type === 'MultiPolygon') return geometry;
    throw new Error(`boundary must be a Polygon or MultiPolygon, got ${geometry.type}`);
}

// The authored footprints may follow a boundary that differs from DataSF's by centimetres along the
// edge; the server refuses any footprint area outside the site, so the site is the boundary grown by
// a hair around exactly the footprints that cross it (reported).
export function siteCoveringFootprints(site, features, bufferM = 0.3) {
    let covered = turf.feature(site);
    const widened = [];
    for (const feature of features) {
        let outside = null;
        // turf 6.5: two features, not a FeatureCollection.
        try { outside = turf.difference(turf.feature(feature.geometry), covered); } catch (_) { outside = null; }
        if (!outside || turf.area(outside) <= 0) continue;
        const grown = turf.buffer(turf.feature(feature.geometry), bufferM, { units: 'meters' });
        const merged = turf.union(covered, grown);
        if (!merged) continue;
        covered = merged;
        widened.push(feature.properties && feature.properties.id);
    }
    const geometry = covered.geometry.type === 'Polygon'
        ? { type: 'MultiPolygon', coordinates: [covered.geometry.coordinates] }
        : covered.geometry;
    return { site: geometry, widened };
}

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
 * Publish a converted record: skip when its proposalId already exists, otherwise bind the site
 * against the city's parcel source and POST the record with that binding declared.
 */
export async function publish(record, { backend, origin, city, parcelSourceId = DEFAULTS.parcelSourceId }) {
    const existing = await request(backend, origin, 'GET', `/proposals/${encodeURIComponent(record.proposalId)}`);
    if (existing.status === 200) {
        log(`proposal ${record.proposalId} already exists on ${backend} (row ${existing.json && existing.json.id}); leaving it alone`);
        return { skipped: true, id: existing.json && existing.json.id };
    }
    log(`binding the site against ${parcelSourceId}…`);
    const bound = await request(backend, origin, 'POST', '/proposals/binding', {
        site: record.site, toleranceM: record.toleranceM, city, parcelSourceId
    });
    if (bound.status !== 200 || !bound.json || !bound.json.binding) {
        throw new Error(`binding failed (${bound.status}): ${bound.text.slice(0, 300)}`);
    }
    const binding = bound.json.binding;
    const parcelIds = (binding.parcels || []).map(parcel => parcel.parcelId);
    log(`site binds to ${parcelIds.length} parcels (coverage ${binding.coverage}, unsurveyed ${Math.round(binding.unsurveyedM2 || 0)} m², ${bound.json.queryMs} ms)`);
    const body = { ...record, cadastreParcelIds: parcelIds, parcelSourceId };
    const created = await request(backend, origin, 'POST', '/proposals', body);
    if (created.status < 200 || created.status >= 300) {
        throw new Error(`create failed (${created.status}): ${created.text.slice(0, 500)}`);
    }
    const id = created.json && (created.json.id ?? created.json.proposal?.id);
    log(`created proposal ${record.proposalId} (row ${id}) with ${parcelIds.length} parcels`);
    // The server returns the edit token exactly once; hand it back so the caller can keep it.
    return { skipped: false, id, parcelIds, editToken: (created.json && created.json.editToken) || null };
}
