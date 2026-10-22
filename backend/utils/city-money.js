// A city's money for server-side code (the agents' planner, the agreements they publish): the
// browser's own CityMoney over the browser's own city configs, so a bot counts London in GBP and
// Zagreb in EUR exactly as the app does. frontend/js/city-config.js is evaluated once, in a vm.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
const CityMoney = require('../../frontend/js/city-money.js');

let manager = null;
function cityConfigs() {
    if (!manager) {
        const context = { console, URL, URLSearchParams };
        context.window = context;
        runInNewContext(readFileSync(new URL('../../frontend/js/city-config.js', import.meta.url), 'utf8'), context);
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
