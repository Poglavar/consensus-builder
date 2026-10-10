// The city a new publication belongs to (projections.md §10 M8): it follows the SITE, never the
// view the author drew it from. The app's cadastres cover the configured cities' areas, as the
// globe draws them (frontend/data/world-coverage.json, world-coverage.js liveCitiesAt), and a site is
// placed among the cities whose parcels cover it:
//   - inside the requested city's own area: that city;
//   - inside another city's area that reads the same cadastre (Croatia's countrywide one, a shared
//     national source): THAT city — the binding is identical, and the record is listed where it is;
//   - beyond every city's area, in the requested city's countrywide cadastre: the requested city;
//   - covered only by other cadastres: refused, naming the city to publish from. (A Zagreb street
//     drawn while New York is loaded would otherwise be bound against New York's source and claim
//     no parcels at all, or an explore site in Paris be bound as open ground.);
//   - covered by no app cadastre: the requested city, whose own source decides (the areas are
//     conservative, a source may reach beyond them); for explore, open ground;
//   - no city requested: the nearest city whose parcels cover the site, else explore — a record
//     never goes without a city (a city-less record could be opened in any city's store).
// Only new publications are placed (checkProposalBinding, the binding preview): stored records keep
// their city, and drift and migrations measure them with it.

import { createRequire } from 'node:module';
import { parcelSourceCatalog, resolveParcelSourceDescriptor } from '../parcels/sources.js';

const requireCjs = createRequire(import.meta.url);
const WorldCoverage = requireCjs('../../frontend/js/world/world-coverage.js');

// City ids configured with no cadastre at all (frontend/js/city-config.js parcels.source 'none').
export const NO_CADASTRE_CITIES = Object.freeze(['explore']);
export const SITE_IN_OTHER_CITY = 'site-in-other-city';

let coverage = null;
function worldCoverage() {
    if (!coverage) coverage = WorldCoverage.create(requireCjs('../../frontend/data/world-coverage.json'));
    return coverage;
}

const servingSources = city => parcelSourceCatalog.sources.filter(source => source.cityIds.includes(city));
// The source a city binds against when the request names none (parcels/sources.js
// parcelSourceForCity); null = the server's own cadastre (PostGIS, Croatia's countrywide table).
const defaultSourceId = city => servingSources(city).find(source => source.defaultForCity !== false)?.id ?? null;

/**
 * Whether a publication requested for `city` binds exactly as one for `other` would: the source the
 * request names serves both, or (none named) both default to the same provider and some catalogued
 * source serves both — so two unrelated cities that merely both default to the server's own
 * cadastre (Zagreb and New York) do not share one.
 */
export function sharesCadastre(city, other, parcelSourceId = null) {
    if (city === other) return true;
    if (parcelSourceId) {
        let descriptor = null;
        try { descriptor = resolveParcelSourceDescriptor(parcelSourceId); } catch (_) { descriptor = null; }
        return !!descriptor && descriptor.cityIds.includes(city) && descriptor.cityIds.includes(other);
    }
    if (defaultSourceId(city) !== defaultSourceId(other)) return false;
    const served = new Set(servingSources(other).map(source => source.id));
    return servingSources(city).some(source => served.has(source.id));
}

// The configured cities whose parcels cover a point, nearest first (see world-coverage.js
// liveCitiesAt): for an audit of records that name no city.
export function citiesCovering({ lon, lat }) {
    return worldCoverage().liveCitiesAt(lat, lon);
}

function refusal(city, siteCity) {
    const message = NO_CADASTRE_CITIES.includes(city)
        ? `The site lies in ${siteCity}, whose parcels the app loads: publish it from ${siteCity}, not from explore.`
        : `The site lies in ${siteCity}, not in ${city}, and ${city}'s parcels do not cover it. Publish it from ${siteCity}.`;
    return Object.assign(new Error(message), { code: SITE_IN_OTHER_CITY, status: 422, city, siteCity });
}

/**
 * The city a new publication requested for `city` belongs to, from its site's anchor.
 * @param {{ city: string|null, parcelSourceId?: string|null, lon: number, lat: number }} input
 *   `city` normalised (routes/proposals.js normalizeCityCode); no city: placed where the site is.
 * @returns {string}
 * Throws { code: 'site-in-other-city', status: 422, city, siteCity } when only other cadastres
 * cover the site.
 */
export function resolvePublicationCity({ city, parcelSourceId = null, lon, lat }) {
    const covering = worldCoverage().liveCitiesAt(lat, lon);
    if (!city) return covering[0]?.cityId || NO_CADASTRE_CITIES[0];
    if (NO_CADASTRE_CITIES.includes(city)) {
        if (covering.length) throw refusal(city, covering[0].cityId);
        return city;
    }
    const areas = covering.filter(hit => hit.via === 'radius');
    if (areas.some(hit => hit.cityId === city)) return city;
    const sameCadastreArea = areas.find(hit => sharesCadastre(city, hit.cityId, parcelSourceId));
    if (sameCadastreArea) return sameCadastreArea.cityId;
    if (areas.length) throw refusal(city, areas[0].cityId);
    // beyond every city's own area: in the requested city's countrywide cadastre (Osijek from
    // Zagreb), or in another country's (Osijek from New York)
    if (covering.length && !covering.some(hit => hit.cityId === city)) throw refusal(city, covering[0].cityId);
    return city;
}
