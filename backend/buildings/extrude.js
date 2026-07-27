// Extrudes a 2D building footprint (GeoJSON Polygon/MultiPolygon in lng/lat) up to a
// given height into the flat-face mesh shape the 3D renderer consumes — the same
// { faces: [<GeoJSON Polygon with [lng,lat,z] coords in metres>] } format that Zagreb's
// pre-built `gdi_building_3d` meshes produce. Cities whose only 3D source is footprint+height
// (e.g. NYC) run their footprints through this so the frontend stays source-agnostic.
//
// It is also how a CUT building is rebuilt: carve.js re-extrudes the `remainder` polygon the
// demolition record already carries (footprint − corridor, subtracted at draw time). A mesh cannot
// be sliced face by face, so a cut building trades its facade detail for the truth about its shape
// — exactly what the 3D view already does client-side.

// Walls: one vertical quad per footprint edge. Roof: the footprint outline (with holes)
// lifted to the roof height. The base is left open — it never faces the camera in a
// ground-level scene, so omitting it halves the wall-adjacent payload.
function ringWalls(ring, baseZ, topZ, faces) {
    for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        if (!a || !b || a.length < 2 || b.length < 2) continue;
        faces.push({
            type: 'Polygon',
            coordinates: [[
                [a[0], a[1], baseZ],
                [b[0], b[1], baseZ],
                [b[0], b[1], topZ],
                [a[0], a[1], topZ],
                [a[0], a[1], baseZ]
            ]]
        });
    }
}

// polygon: array of rings (outer + optional holes), each a closed [ [lng,lat], ... ] ring.
function extrudePolygon(polygon, baseZ, topZ, faces) {
    if (!Array.isArray(polygon) || polygon.length === 0) return;
    for (const ring of polygon) {
        if (Array.isArray(ring) && ring.length >= 4) ringWalls(ring, baseZ, topZ, faces);
    }
    // Roof: same rings (outer drives the outline, the rest punch holes) at roof height.
    const roof = polygon
        .filter(r => Array.isArray(r) && r.length >= 4)
        .map(r => r.map(c => [c[0], c[1], topZ]));
    if (roof.length > 0) faces.push({ type: 'Polygon', coordinates: roof });
}

// Returns the building record in the common renderer shape, or null if degenerate.
//
// `baseZ` is the elevation the walls rise FROM, in the same frame as the source data's Z. It is 0
// for footprint+height cities (NYC), where Z is height above ground. Zagreb's `gdi_building_3d`
// faces carry ABSOLUTE elevation instead (z_min is the ground under the building, ~120 m in the
// centre), so re-extruding one of those meshes must pass its z_min or the rebuilt building sinks
// to sea level.
export function extrudeFootprint(objectId, geometry, heightMeters, baseZ = 0) {
    if (!geometry || !(heightMeters > 0)) return null;
    const base = Number.isFinite(Number(baseZ)) ? Number(baseZ) : 0;
    const top = base + heightMeters;
    const faces = [];
    if (geometry.type === 'Polygon') {
        extrudePolygon(geometry.coordinates, base, top, faces);
    } else if (geometry.type === 'MultiPolygon') {
        for (const poly of geometry.coordinates) extrudePolygon(poly, base, top, faces);
    } else {
        return null;
    }
    if (faces.length === 0) return null;
    return { object_id: objectId, z_min: base, z_max: top, faces };
}
