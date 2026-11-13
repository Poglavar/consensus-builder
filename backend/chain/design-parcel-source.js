// The parcel source a design read from a chain is bound with when the chain watcher indexes it.
// The index takes the source from its consumer and never picks one by city (parcels/sources.js), so
// the watcher acts as the browser does when it publishes (DesignSync.parcelSourceIdOf): the configured
// parcel source of the design's own city in frontend/data/city-configs.js, through the browser's
// CityConfigManager evaluated in node. The browser can also place the city by the design's geometry
// (its boot coverage); here the design's `city` field decides.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const read = file => readFileSync(new URL(`../../frontend/${file}`, import.meta.url), 'utf8');
let manager = null;

function cityConfigManager() {
    if (!manager) {
        const context = { URLSearchParams, console };
        context.window = context;
        runInNewContext(`${read('js/source-list.js')}\n${read('data/city-configs.js')}\n${read('js/city-config.js')}`, context);
        manager = context.CityConfigManager;
    }
    return manager;
}

/** The parcel source id of a design/v1 object's city, or null when its city is not configured. */
export function designParcelSourceId(content) {
    const city = typeof content?.city === 'string' ? content.city : null;
    if (!city) return null;
    return cityConfigManager().getDataContext(null, city)?.parcelSourceId || null;
}
