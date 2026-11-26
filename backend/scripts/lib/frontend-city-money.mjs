// A city's money for server-side code (the agents' planner, the agreements they publish): the
// browser's own CityMoney over the browser's own city configs, so a bot counts London in GBP and
// Zagreb in EUR exactly as the app does. frontend/data/city-configs.js (every city's configuration)
// and frontend/js/city-config.js (the manager) are evaluated once, in one vm context.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createContext, runInContext } from 'node:vm';

const require = createRequire(import.meta.url);
const CityMoney = require('../../../frontend/js/city-money.js');
const SourceList = require('../../../frontend/js/source-list.js');

let manager = null;
function cityConfigs() {
    if (!manager) {
        const context = { console, URL, URLSearchParams };
        context.window = context;
        createContext(context);
        for (const file of ['../../../frontend/data/city-configs.js', '../../../frontend/js/city-config.js']) {
            runInContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
        }
        manager = context.CityConfigManager;
    }
    return manager;
}

// CityMoney's view of one city (currentCurrency, currentFloorAreaPrices, …). Throws for a city the
// app does not configure: a bot never guesses which money a place counts in.
export function cityMoney(cityId) {
    const config = cityConfigs().getCityConfig(cityId);
    if (!config || config.id !== cityId) throw new Error(`No city config for "${cityId}"; its currency is unknown.`);
    return CityMoney.forCity(() => config);
}

// The side of the road a city's traffic keeps to ('left' or 'right'), as the browser's
// CityConfigManager.getDrivingSide reads it: the MCP drafts and imports roads for that city with it.
export function cityDrivingSide(cityId) {
    return cityConfigs().getDrivingSide(cityId);
}

// The planning rule sets a city's Permitted applies (planning-sources.json `ruleSets`), by id.
export function cityPlanningRuleSetIds(cityId) {
    const config = cityConfigs().getCityConfig(cityId);
    return config?.id === cityId ? config.planning?.ruleSetIds || [] : [];
}

// The Permitted sources a city's planning layer reads (city config planning.sourceIds), first the default.
export function cityPlanningSourceIds(cityId) {
    const config = cityConfigs().getCityConfig(cityId);
    return config?.id === cityId ? config.planning?.sourceIds || [] : [];
}

export function cityBuildingSources(cityId) {
    const config = cityConfigs().getCityConfig(cityId);
    return config?.id === cityId ? SourceList.inUse(SourceList.cityList(config)) : [];
}
