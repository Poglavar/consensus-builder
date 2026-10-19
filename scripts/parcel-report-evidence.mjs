// Collect explicit parcel-source evidence from per-city records and registry country rows.
// This reads local JSON only; it performs no network I/O and never scans historical research.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const POSITIVE_NATIONAL = new Set([
    'national_online_cadastre_verified_sample', 'national_cadastre_credentialed_or_paid',
    'national_cadastre_viewer_only', 'covered_by_parent_source'
]);
const CITY_ROOT = 'world-parcels/cities';

function unique(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length))];
}

function normalizeDate(value) {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    if (!match) return null;
    const date = new Date(`${match[1]}T00:00:00Z`);
    return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1] ? null : match[1];
}

function safeUrls(values) {
    return unique(values).flatMap(value => {
        try {
            const url = new URL(value);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return [];
            if ([...url.searchParams.keys()].some(key => /(?:^|[_-])(token|api[_-]?key|key|secret|password|passwd|authorization|signature|sig)(?:$|[_-])/i.test(key))) return [];
            url.hash = '';
            return [url.toString()];
        } catch { return []; }
    });
}

function relativeCityPath(code, name) {
    return `cities/${code}/${name}`;
}

function readCityRecord(repoRoot, code, warnings) {
    if (!/^\d+$/.test(String(code ?? ''))) return null;
    const directory = path.join(repoRoot, CITY_ROOT, String(code));
    const settingsPath = path.join(directory, 'settings.json');
    const failedPath = path.join(directory, 'failed-urls.json');
    let settings = null;
    let failedUrls = [];
    const evidenceFiles = [];

    if (existsSync(settingsPath)) {
        evidenceFiles.push(relativeCityPath(code, 'settings.json'));
        try {
            const parsed = JSON.parse(readFileSync(settingsPath, 'utf8'));
            if (parsed?.schemaVersion === 1 && String(parsed.cityCode) === String(code)
                && Array.isArray(parsed.bindings) && Array.isArray(parsed.sources)) {
                settings = parsed;
            } else {
                warnings.push(`Invalid city settings record: ${relativeCityPath(code, 'settings.json')}`);
            }
        } catch {
            warnings.push(`Could not parse city settings record: ${relativeCityPath(code, 'settings.json')}`);
        }
    }
    if (existsSync(failedPath)) {
        evidenceFiles.push(relativeCityPath(code, 'failed-urls.json'));
        try {
            const parsed = JSON.parse(readFileSync(failedPath, 'utf8'));
            if (Array.isArray(parsed)) failedUrls = safeUrls(parsed.map(item => item?.url));
            else warnings.push(`Invalid failed URL record: ${relativeCityPath(code, 'failed-urls.json')}`);
        } catch {
            warnings.push(`Could not parse failed URL record: ${relativeCityPath(code, 'failed-urls.json')}`);
        }
    }
    return { settings, failedUrls, evidenceFiles, hasFailedRecord: existsSync(failedPath) };
}

function bindingSourceIds(binding) {
    const parcels = binding?.runtimeConfig?.parcels;
    if (!parcels || typeof parcels !== 'object') return [];
    const ids = [parcels.sourceId, parcels.liveSource?.sourceId,
        ...(Array.isArray(parcels.sources) ? parcels.sources.map(source => source?.sourceId || source?.id) : [])];
    if (parcels.source && parcels.source !== 'parcel-source') ids.push(parcels.source);
    return unique(ids);
}

function sourcesForBindings(settings, bindings) {
    if (!settings || !bindings.length) return [];
    const appIds = new Set(bindings.map(binding => binding.appCityId));
    const requested = new Set(bindings.flatMap(bindingSourceIds));
    return settings.sources.filter(source => {
        if (!source || typeof source.id !== 'string' || !source.id) return false;
        if (Array.isArray(source.cityIds) && !source.cityIds.some(id => appIds.has(id))) return false;
        return requested.size === 0 || requested.has(source.id);
    });
}

function validBindings(settings, appCityId = null) {
    if (!settings) return [];
    return settings.bindings.filter(binding => typeof binding?.appCityId === 'string'
        && binding.appCityId && binding.runtimeConfig?.id === binding.appCityId
        && binding.runtimeConfig?.parcels && (!appCityId || binding.appCityId === appCityId));
}

function cityResult(city, record, sources) {
    const configured = sources.length > 0;
    const sourceIds = configured ? unique(sources.map(source => source.id)) : [];
    const failureUrls = record?.failedUrls || [];
    const sourceUrls = configured ? sources.map(source => source.endpoint) : [];
    return {
        cityId: city.cityId,
        checked: configured || Boolean(record?.hasFailedRecord),
        checkedDate: null,
        checkedDateEvidence: null,
        registryFound: configured ? true : null,
        registryBasis: configured
            ? 'A validated parcel source is configured for this city; citywide completeness remains unverified.'
            : null,
        verifiedSample: configured,
        sourceIds,
        evidenceUrls: safeUrls([...sourceUrls, ...failureUrls]),
        failureUrls,
        evidenceFiles: record?.evidenceFiles || [],
        impliedParcelsTried: null
    };
}

/**
 * Build city and country evidence from per-city settings/failure records and registry country rows.
 * Returned evidence file paths are relative to world-parcels/.
 */
export function collectReportEvidence({ registry, repoRoot, appCities = [], sourceCatalog: _sourceCatalog = { sources: [] } }) {
    if (!registry || !Array.isArray(registry.cities) || !Array.isArray(registry.sources)) {
        throw new TypeError('registry must include cities and sources arrays');
    }
    const warnings = [];
    const recordsByCode = new Map();
    const recordFor = code => {
        const key = String(code ?? '');
        if (!recordsByCode.has(key)) recordsByCode.set(key, readCityRecord(repoRoot, key, warnings));
        return recordsByCode.get(key);
    };

    const cities = registry.cities.map(city => {
        const code = city.wupCityCode;
        const record = recordFor(code);
        const bindings = validBindings(record?.settings);
        const sources = record?.settings && !record.settings.bindings.length
            ? record.settings.sources.filter(source => source?.id && source.endpoint)
            : sourcesForBindings(record?.settings, bindings);
        return cityResult(city, record, sources);
    });

    // App identities are bound only by explicit settings.bindings.appCityId values.
    // Names, proximity, source reuse, and source catalog city lists never create bindings.
    const settingsDirectory = path.join(repoRoot, CITY_ROOT);
    const settingsByAppId = new Map();
    if (existsSync(settingsDirectory)) {
        for (const entry of readdirSync(settingsDirectory, { withFileTypes: true })) {
            if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
            const record = recordFor(entry.name);
            for (const binding of validBindings(record?.settings)) {
                const rows = settingsByAppId.get(binding.appCityId) || [];
                rows.push({ record, binding });
                settingsByAppId.set(binding.appCityId, rows);
            }
        }
    }
    const appCityEvidence = appCities.map(appCity => {
        const rows = settingsByAppId.get(appCity.id) || [];
        const sources = rows.flatMap(({ record, binding }) => sourcesForBindings(record.settings, [binding]));
        const uniqueSources = [...new Map(sources.map(source => [source.id, source])).values()];
        const evidenceFiles = unique(rows.flatMap(({ record }) => record.evidenceFiles));
        const failureUrls = safeUrls(rows.flatMap(({ record }) => record.failedUrls));
        const configured = uniqueSources.length > 0;
        return {
            cityId: `app:${appCity.id}`,
            checked: configured || rows.some(({ record }) => record.hasFailedRecord),
            checkedDate: null,
            checkedDateEvidence: null,
            registryFound: configured ? true : null,
            verifiedSample: configured,
            sourceIds: configured ? unique(uniqueSources.map(source => source.id)) : [],
            evidenceUrls: safeUrls([...uniqueSources.map(source => source.endpoint), ...failureUrls]),
            failureUrls,
            evidenceFiles,
            impliedParcelsTried: null
        };
    });

    const probes = new Map((registry.countryProbes || []).map(probe => [probe.countryCode, probe]));
    const countryCoverage = new Map((registry.countryCoverage || []).map(row => [row.countryCode, row]));
    const subnational = new Map((registry.subnationalCoverage || []).map(row => [row.countryCode, row]));
    const countryCodes = unique([...probes.keys(), ...countryCoverage.keys(), ...subnational.keys()]).sort();
    const countries = countryCodes.map(countryCode => {
        const probe = probes.get(countryCode);
        const coverage = countryCoverage.get(countryCode);
        const regional = subnational.get(countryCode);
        const status = probe?.status || null;
        const coverageSampled = coverage?.status === 'verified_countrywide';
        const parentSource = status === 'covered_by_parent_source';
        const positive = POSITIVE_NATIONAL.has(status) || coverageSampled;
        const nationalCadastreFound = positive ? true
            : ['no_online_cadastre_found', 'subnational_only'].includes(status) ? false : null;
        const evidenceFiles = probe || coverage ? ['registry.json'] : [];
        const checkedDate = [normalizeDate(probe?.checkedAt), normalizeDate(coverage?.checkedAt)]
            .filter(Boolean).sort().at(-1) || null;
        const evidenceUrls = safeUrls([
            probe?.inspireRecordUrl,
            ...(probe?.sources || []).map(source => source.endpoint),
            ...(coverage?.sources || []).map(source => source.endpoint)
        ]);
        return {
            countryCode,
            checked: Boolean(checkedDate),
            checkedDate,
            nationalCadastreFound,
            verifiedNationalSample: status === 'national_online_cadastre_verified_sample',
            countryCoverageSampled: coverageSampled,
            subnationalEvidence: regional ? {
                regionsTotal: regional.regionsTotal ?? null,
                regionWide: regional.regionWide ?? null,
                partial: regional.partial ?? null,
                ruralRegistryOnly: regional.ruralRegistryOnly ?? 0,
                regions: (regional.regions || []).map(region => ({
                    code: region.code, name: region.name, status: region.status, bucket: region.bucket,
                    evidenceFile: 'registry.json'
                }))
            } : null,
            parentSource,
            evidenceUrls,
            evidenceFiles,
            probeStatus: status
        };
    });

    return { cities, appCities: appCityEvidence, countries, warnings: unique(warnings) };
}
