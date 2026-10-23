// Consumer configuration fixtures for source-admission tests; backend services do not select by city.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parcelSourceCatalog, parcelSourceById } from '../../parcels/sources.js';
const context = { URLSearchParams, console }; context.window = context;
runInNewContext(readFileSync(new URL('../../../frontend/js/city-config.js', import.meta.url), 'utf8'), context);
export const manager = context.CityConfigManager;
export function consumerParcelSourceId(city) {
    const config = manager.getCityConfig(city);
    const p = config?.id === city ? config.parcels : null;
    return p?.sourceId || p?.source || parcelSourceCatalog.sources.find(s => s.defaultForCity !== false && s.cityIds.includes(city))?.id || null;
}
export function parcelSourceForCity(city, sourceId = consumerParcelSourceId(city)) {
    if (['oss-wfs', 'parcel-nyc', 'none'].includes(sourceId) || !sourceId) return null;
    const selected = parcelSourceById(sourceId);
    return selected.descriptor.metricSridByCity ? { ...selected, descriptor: { ...selected.descriptor, metricSrid: selected.descriptor.metricSridByCity[city] } } : selected;
}
export function parcelSourceForIds(ids) {
    const descriptor = parcelSourceCatalog.sources.filter(s => ids.some(id => String(id).startsWith(s.idPrefix)))
        .sort((a,b) => b.idPrefix.length - a.idPrefix.length)[0];
    return descriptor && (descriptor.defaultForCity !== false || descriptor.historicalForIds === true)
        ? parcelSourceById(descriptor.id) : null;
}
