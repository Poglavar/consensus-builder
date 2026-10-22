// The city a new publication belongs to (projections.md §10 M8, location-first.md phase 4): the one
// whose parcels apply where its SITE lies, by the rule the boot and the globe use
// (jurisdiction.js / world-coverage.js jurisdictionAt over frontend/data/world-coverage.json). The
// view the author drew it from, or a city the request names, never decides:
//   - covered by some city's parcels: that city (a Zagreb street drawn while New York is loaded is
//     Zagreb's, bound against Zagreb's cadastre; an explore site in Paris is Paris's);
//   - covered by none: the requested city, whose own source decides (the coverage areas are
//     conservative, a source may reach beyond them), else explore (open ground).
// A parcel source the request names (a visitor's choice for their city) applies only where it serves
// the placed city; elsewhere the placed city's own source binds. So nothing is refused for where it
// was drawn from, and a record never goes without a city.
// Only new publications are placed (checkProposalBinding, the binding preview): stored records keep
// their city, and drift and migrations measure them with it.

import { resolveParcelSourceDescriptor } from '../parcels/sources.js';
import { worldCoverage } from '../jurisdiction.js';

// City ids configured with no cadastre at all (frontend/js/city-config.js parcels.source 'none').
export const NO_CADASTRE_CITIES = Object.freeze(['explore']);

// Whether the catalogued source `sourceId` serves `city`.
export function sourceServes(sourceId, city) {
    let descriptor = null;
    try { descriptor = resolveParcelSourceDescriptor(sourceId); } catch (_) { descriptor = null; }
    return !!descriptor && descriptor.cityIds.includes(city);
}

// The configured cities whose parcels cover a point, nearest first (see world-coverage.js
// liveCitiesAt): for an audit of records that name no city.
export function citiesCovering({ lon, lat }) {
    return worldCoverage().liveCitiesAt(lat, lon);
}

/**
 * Where a new publication of a site anchored at (lon, lat) is filed, and which source binds it.
 * @param {{ city?: string|null, parcelSourceId?: string|null, lon: number, lat: number }} input
 *   `city` normalised (utils/city-code.js normalizeCityCode), used only where no city covers the site.
 * @returns {{ city: string, parcelSourceId: string|null }}
 */
export function resolvePublicationCity({ city = null, parcelSourceId = null, lon, lat }) {
    const placed = worldCoverage().jurisdictionAt(lat, lon) || city || NO_CADASTRE_CITIES[0];
    return { city: placed, parcelSourceId: parcelSourceId && sourceServes(parcelSourceId, placed) ? parcelSourceId : null };
}
