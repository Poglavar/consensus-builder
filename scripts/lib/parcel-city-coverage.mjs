// Current per-city coverage contract: only validated settings imply a working parcel check;
// a failed URL record marks an attempted city, never a citywide absence finding.
import fs from 'node:fs';
import path from 'node:path';

function cityCode(value) {
    const code = Number(value);
    return Number.isSafeInteger(code) && code > 0 ? code : null;
}

function validPoint(value) {
    return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1])
        && value[0] >= -90 && value[0] <= 90 && value[1] >= -180 && value[1] <= 180
        ? [value[0], value[1]] : null;
}

function identityRows(registry, demographics) {
    const byCode = new Map();
    for (const city of registry?.cities || []) {
        const code = cityCode(city.wupCityCode);
        if (code === null) continue;
        const row = byCode.get(code) || { cityCode: code, appCityIds: new Set() };
        row.cityName ||= city.name;
        row.countryCode ||= city.countryCode;
        row.point ||= validPoint(city.centerLatLon);
        byCode.set(code, row);
    }
    for (const city of demographics?.cities || []) {
        const code = cityCode(city.wupCityCode);
        if (code === null) continue;
        const row = byCode.get(code) || { cityCode: code, appCityIds: new Set() };
        row.cityName ||= city.name || city.wupName;
        row.countryCode ||= city.countryCode;
        row.point ||= validPoint([city.latitude, city.longitude])
            || validPoint([city.wupLatitude, city.wupLongitude]);
        for (const appCityId of city.appCityIds || []) if (typeof appCityId === 'string') row.appCityIds.add(appCityId);
        byCode.set(code, row);
    }
    return byCode;
}

function isWorkingSettings(settings, code) {
    if (settings?.schemaVersion !== 1 || String(settings.cityCode) !== String(code)
        || !Array.isArray(settings.bindings)
        || !Array.isArray(settings.sources) || !settings.sources.length) return false;
    const sourceIds = new Set(settings.sources.filter(source => source && typeof source.id === 'string'
        && source.id && (source.adapter || source.ownership?.adapter)).map(source => source.id));
    if (!sourceIds.size) return false;
    if (!settings.bindings.length) return true;
    return settings.bindings.some(binding => {
        const parcels = binding?.runtimeConfig?.parcels;
        if (!binding?.appCityId || binding.runtimeConfig?.id !== binding.appCityId || !parcels) return false;
        const ids = [parcels.sourceId, parcels.liveSource?.sourceId,
            ...(Array.isArray(parcels.sources) ? parcels.sources.map(source => source?.sourceId || source?.id) : [])]
            .filter(id => typeof id === 'string' && id);
        return ids.some(id => sourceIds.has(id)) || settings.sources.some(source => source.id === parcels.source);
    });
}

function hasFailedUrlRecord(file) {
    if (!fs.existsSync(file)) return false;
    const record = readJson(file);
    if (!Array.isArray(record)) throw new Error('Invalid failed URL city record');
    return true;
}

function readJson(file) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
}

export function readCityChecks(repoRoot, { registry, demographics } = {}) {
    const world = path.join(repoRoot, 'world-parcels');
    registry ||= readJson(path.join(world, 'registry.json'));
    demographics ||= readJson(path.join(world, 'report/city-demographics.json'));
    const identities = identityRows(registry, demographics);
    const citiesDir = path.join(world, 'cities');
    let directories = [];
    try { directories = fs.readdirSync(citiesDir, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)); }
    catch { return []; }
    const checks = [];
    for (const entry of directories) {
        const code = cityCode(entry.name);
        const identity = identities.get(code);
        if (!identity) continue;
        const directory = path.join(citiesDir, entry.name);
        const settings = readJson(path.join(directory, 'settings.json'));
        const settingsMatch = settings?.schemaVersion === 1 && String(settings.cityCode) === entry.name;
        const working = isWorkingSettings(settings, entry.name);
        const held = !working && hasFailedUrlRecord(path.join(directory, 'failed-urls.json'));
        if (!working && !held) continue;
        const mappedBinding = settingsMatch ? settings.bindings?.find(binding =>
            Number(binding.runtimeConfig?.wupCityCode) === code || identity.appCityIds?.has(binding.appCityId)) : null;
        const settingPoint = settingsMatch
            ? validPoint(settings.point) || validPoint(mappedBinding?.runtimeConfig?.map?.defaultCenter) : null;
        const point = identity.point || settingPoint;
        if (!point) continue;
        const sourceCountry = settingsMatch ? settings.sources?.find(source => typeof source.countryCode === 'string')?.countryCode : null;
        const cityName = identity.cityName || (settingsMatch ? settings.name : null);
        const countryCode = identity.countryCode || sourceCountry;
        if (!cityName || !countryCode) continue;
        const appCityIds = working
            ? [...new Set([...(identity.appCityIds || []), ...(settings.bindings || []).map(binding => binding.appCityId).filter(Boolean)])]
            : [];
        checks.push({ cityCode: code, cityName, countryCode, point, outcome: working ? 'qualified' : 'held', appCityIds });
    }
    return checks.sort((a, b) => a.cityCode - b.cityCode);
}
