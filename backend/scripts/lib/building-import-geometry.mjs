// Normalize supplied building volumes into ordinary connected Freeform footprints. Preserve every
// polygon and hole; where height volumes overlap, the tallest volume owns their shared footprint.
import * as turf from '@turf/turf';

export function polygonBuildingParts(features) {
    return features.flatMap(feature => {
        const geometry = feature?.geometry;
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
        if (!polygons?.length) throw new Error('Imported buildings need Polygon or MultiPolygon geometry.');
        const sourceId = String(feature.properties?.id ?? feature.id ?? '');
        if (!sourceId) throw new Error('Imported buildings need a stable source identity.');
        return polygons.map((coordinates, index) => ({
            ...structuredClone(feature),
            properties: { ...structuredClone(feature.properties || {}),
                sourceFeatureId: feature.properties?.sourceFeatureId || sourceId,
                id: polygons.length > 1 ? `${sourceId}-part-${index + 1}` : sourceId },
            geometry: { type: 'Polygon', coordinates: structuredClone(coordinates) }
        }));
    });
}

const boxesOverlap = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

export function partitionBuildingFootprints(features) {
    const ordered = features.map(feature => structuredClone(feature)).sort((a,b) =>
        Number(b.properties.height) - Number(a.properties.height) || String(a.properties.id).localeCompare(String(b.properties.id)));
    const accepted = [];
    for (const feature of ordered) {
        if (!(Number(feature.properties?.height) > 0)) throw new Error(`Invalid height for ${feature.properties?.id}.`);
        let remaining = feature;
        for (const standing of accepted) {
            if (!remaining) break;
            if (!boxesOverlap(turf.bbox(remaining), turf.bbox(standing))) continue;
            remaining = turf.difference(remaining, standing);
        }
        // A lower volume wholly inside a taller one adds no built volume or footprint of its own.
        if (!remaining) continue;
        remaining.properties = structuredClone(feature.properties);
        accepted.push(...polygonBuildingParts([remaining]));
    }
    return accepted;
}
