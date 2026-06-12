// Extrudes a 2D building footprint (GeoJSON Polygon/MultiPolygon in lng/lat) up to a
// given height into the flat-face mesh shape the 3D renderer consumes — the same
// { faces: [<GeoJSON Polygon with [lng,lat,z] coords in metres>] } format that Zagreb's
// pre-built `building_3d` meshes produce. Cities whose only 3D source is footprint+height
// (e.g. NYC) run their footprints through this so the frontend stays source-agnostic.

// Walls: one vertical quad per footprint edge. Roof: the footprint outline (with holes)
// lifted to the roof height. The base is left open — it never faces the camera in a
// ground-level scene, so omitting it halves the wall-adjacent payload.
function ringWalls(ring, height, faces) {
    for (let i = 0; i < ring.length - 1; i++) {
        const a = ring[i];
        const b = ring[i + 1];
        if (!a || !b || a.length < 2 || b.length < 2) continue;
        faces.push({
            type: 'Polygon',
            coordinates: [[
                [a[0], a[1], 0],
                [b[0], b[1], 0],
                [b[0], b[1], height],
                [a[0], a[1], height],
                [a[0], a[1], 0]
            ]]
        });
    }
}

// polygon: array of rings (outer + optional holes), each a closed [ [lng,lat], ... ] ring.
function extrudePolygon(polygon, height, faces) {
    if (!Array.isArray(polygon) || polygon.length === 0) return;
    for (const ring of polygon) {
        if (Array.isArray(ring) && ring.length >= 4) ringWalls(ring, height, faces);
    }
    // Roof: same rings (outer drives the outline, the rest punch holes) at roof height.
    const roof = polygon
        .filter(r => Array.isArray(r) && r.length >= 4)
        .map(r => r.map(c => [c[0], c[1], height]));
    if (roof.length > 0) faces.push({ type: 'Polygon', coordinates: roof });
}

// Returns the building record in the common renderer shape, or null if degenerate.
export function extrudeFootprint(objectId, geometry, heightMeters) {
    if (!geometry || !(heightMeters > 0)) return null;
    const faces = [];
    if (geometry.type === 'Polygon') {
        extrudePolygon(geometry.coordinates, heightMeters, faces);
    } else if (geometry.type === 'MultiPolygon') {
        for (const poly of geometry.coordinates) extrudePolygon(poly, heightMeters, faces);
    } else {
        return null;
    }
    if (faces.length === 0) return null;
    return { object_id: objectId, z_min: 0, z_max: heightMeters, faces };
}
