// Collect explicit, city-scoped research evidence for the global parcel coverage report.
// This reads local registry records and their named evidence files only; it performs no network I/O.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const normalizeDate = value => {
    if (typeof value !== 'string') return null;
    const match = /^(\d{4}-\d{2}-\d{2})(?:$|T)/.exec(value);
    if (!match) return null;
    const date = new Date(`${match[1]}T00:00:00Z`);
    return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== match[1] ? null : match[1];
};

function readEvidence(repoRoot, relativePath, warnings) {
    if (!relativePath || typeof relativePath !== 'string') return null;
    const root = path.resolve(repoRoot);
    const fullPath = path.resolve(root, 'world-parcels', relativePath.replace(/^world-parcels\//, ''));
    if (!fullPath.startsWith(`${root}${path.sep}`)) {
        warnings.push(`Evidence path escapes repository: ${relativePath}`);
        return null;
    }
    if (!existsSync(fullPath)) {
        warnings.push(`Missing referenced evidence file: world-parcels/${relativePath.replace(/^world-parcels\//, '')}`);
        return null;
    }
    try {
        return JSON.parse(readFileSync(fullPath, 'utf8'));
    } catch (error) {
        warnings.push(`Could not parse referenced JSON evidence file: world-parcels/${relativePath.replace(/^world-parcels\//, '')} (${error.message})`);
        return null;
    }
}

function actualDates(value, file, field = '$', output = [], city = null) {
    if (Array.isArray(value)) {
        value.forEach((item, i) => actualDates(item, file, `${field}[${i}]`, output, city));
    } else if (value && typeof value === 'object') {
        const explicitCityId = value.cityId || value.city_id;
        const explicitCitySlug = value.city;
        const evidenceName = value.name || value.cityName || value.city_name;
        const evidenceCountry = value.countryCode || value.country_code;
        const normalizeName = text => String(text || '').normalize('NFKC').trim().toLocaleLowerCase();
        const aliases = city ? [city.cityId, city.appCityId, city.id, city.name, city.label, ...(city.aliases || [])].filter(Boolean).map(normalizeName) : [];
        const explicitIdMatch = typeof explicitCityId === 'string' && aliases.includes(normalizeName(explicitCityId));
        const evidenceCityKey = typeof explicitCitySlug === 'string' ? normalizeName(explicitCitySlug) : null;
        const slugMatch = Boolean(evidenceCityKey && aliases.includes(evidenceCityKey));
        const nameCountryMatch = city && typeof evidenceName === 'string' && typeof evidenceCountry === 'string'
            && aliases.includes(normalizeName(evidenceName))
            && evidenceCountry.toUpperCase() === String(city.countryCode || '').toUpperCase();
        if (city && typeof explicitCityId === 'string' && !explicitIdMatch && !nameCountryMatch && !slugMatch) return output;
        if (city && !explicitCityId && typeof explicitCitySlug === 'string' && !slugMatch && !nameCountryMatch) return output;
        if (city && !explicitCityId && !explicitCitySlug && typeof evidenceName === 'string' && typeof evidenceCountry === 'string' && !nameCountryMatch) return output;
        for (const [key, item] of Object.entries(value)) {
            if (['checkedAt', 'probedAt', 'verifiedAt'].includes(key)) {
                const date = normalizeDate(item);
                if (date) output.push({ date, path: file, field: `${field}.${key}` });
            }
            if (item && typeof item === 'object') actualDates(item, file, `${field}.${key}`, output, city);
        }
    }
    return output;
}

function unique(values) {
    return [...new Set(values.filter(value => typeof value === 'string' && value.length))];
}

function safeUrls(values) {
    return unique(values).filter(value => {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' || url.protocol === 'http:';
        } catch { return false; }
    });
}

function recordFiles(record, keys) {
    const found = [];
    for (const key of keys) {
        const value = record?.[key];
        for (const file of Array.isArray(value) ? value : [value]) {
            if (typeof file === 'string' && file) found.push(file);
        }
    }
    return unique(found);
}

function evidenceNamesCity(value, identity) {
    if (Array.isArray(value)) return value.some(item => evidenceNamesCity(item, identity));
    if (!value || typeof value !== 'object') return false;
    const normalize = text => String(text || '').normalize('NFKC').trim().toLocaleLowerCase();
    const aliases = [identity.id, identity.appCityId, identity.name, identity.label, ...(identity.aliases || [])]
        .filter(Boolean).map(normalize);
    const explicit = value.cityId || value.city_id || value.appCityId || value.city;
    if (typeof explicit === 'string' && aliases.includes(normalize(explicit))) return true;
    const name = value.name || value.cityName || value.city_name;
    const country = value.countryCode || value.country_code;
    if (typeof name === 'string' && typeof country === 'string'
        && aliases.includes(normalize(name))
        && country.toUpperCase() === String(identity.countryCode || '').toUpperCase()) return true;
    return Object.values(value).some(item => item && typeof item === 'object' && evidenceNamesCity(item, identity));
}

function rootConflictsWithCity(value, identity) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const normalize = text => String(text || '').normalize('NFKC').trim().toLocaleLowerCase();
    const aliases = [identity.cityId, identity.appCityId, identity.id, identity.name, identity.label, ...(identity.aliases || [])]
        .filter(Boolean).map(normalize);
    const explicit = value.cityId || value.city_id || value.appCityId || value.city;
    if (typeof explicit === 'string' && !aliases.includes(normalize(explicit))) return true;
    const name = value.name || value.cityName || value.city_name;
    const country = value.countryCode || value.country_code;
    if (typeof name === 'string' && typeof country === 'string') {
        return !(aliases.includes(normalize(name)) && country.toUpperCase() === String(identity.countryCode || '').toUpperCase());
    }
    return false;
}

function cityPaths(city) {
    const found = recordFiles(city, CITY_FILE_FIELDS.filter(key => key !== 'availabilityAudit'));
    for (const key of ['availabilityAudit', 'liveIntegration']) {
        const value = city[key];
        if (value && typeof value === 'object' && typeof value.evidenceFile === 'string') found.push(value.evidenceFile);
    }
    return unique(found);
}

const CITY_FILE_FIELDS = [
    'researchFile', 'previousResearchFile', 'retryFile', 'latestAttemptFile',
    'latestAssessmentFile', 'capitalResearchFile', 'liveAcceptanceFile', 'availabilityAudit'
];
const SOURCE_FILE_FIELDS = ['evidenceFile', 'latestResearchFile', 'latestResearchFiles'];
const POSITIVE_NATIONAL = new Set([
    'national_online_cadastre_verified_sample', 'national_cadastre_credentialed_or_paid',
    'national_cadastre_viewer_only', 'covered_by_parent_source'
]);

/**
 * Build city and country research evidence from registry rows and their explicitly referenced files.
 * Paths in returned evidenceFiles/date evidence are relative to world-parcels/.
 */
export function collectReportEvidence({ registry, repoRoot, appCities = [], sourceCatalog = { sources: [] } }) {
    if (!registry || !Array.isArray(registry.cities) || !Array.isArray(registry.sources)) {
        throw new TypeError('registry must include cities and sources arrays');
    }
    const warnings = [];
    const sourcesById = new Map(registry.sources.map(source => [source.sourceId, source]));
    const cityEvidence = registry.cities.map(city => {
        const sourceIds = unique(city.sourceIds || []);
        const sourceRows = sourceIds.map(id => sourcesById.get(id)).filter(Boolean);
        const files = cityPaths(city);
        const sourceFiles = sourceRows.flatMap(source => source.verifiedCityIds?.includes(city.cityId)
            ? recordFiles(source, SOURCE_FILE_FIELDS) : []);
        const evidenceFiles = unique([...files, ...sourceFiles]);
        const evidenceDates = evidenceFiles.flatMap(file => actualDates(
            readEvidence(repoRoot, file, warnings), file, '$', [], city
        ));
        for (const key of ['availabilityAudit', 'liveIntegration']) {
            const record = city[key];
            if (record && typeof record === 'object') {
                const recordFile = record.evidenceFile || null;
                evidenceDates.push(...actualDates(record, recordFile, '$', [], city));
            }
        }
        for (const source of sourceRows) {
            for (const [index, attempt] of (source.integrationAttempts || []).entries()) {
                const targetText = `${attempt.operation || ''} ${attempt.detail || ''} ${attempt.cityId || ''}`;
                const cityName = String(city.name || '').trim().toLocaleLowerCase();
                const explicitTarget = attempt.cityId || attempt.city_id;
                const targetsCity = explicitTarget
                    ? explicitTarget === city.cityId
                    : Boolean(source.verifiedCityIds?.includes(city.cityId)
                        || (cityName && targetText.toLocaleLowerCase().includes(cityName)));
                if (!targetsCity) continue;
                const date = normalizeDate(attempt.checkedAt);
                if (date) evidenceDates.push({ date, path: attempt.evidenceFile || null, field: `integrationAttempts[${index}].checkedAt` });
                if (attempt.evidenceFile && !evidenceFiles.includes(attempt.evidenceFile)) {
                    evidenceFiles.push(attempt.evidenceFile);
                    // Integration evidence can contain the most recent operational check.
                    evidenceDates.push(...actualDates(readEvidence(repoRoot, attempt.evidenceFile, warnings), attempt.evidenceFile, '$', [], city));
                }
            }
        }
        const status = city.parcelStatus;
        const verifiedSample = typeof status === 'string' && status.startsWith('verified_');
        const discovery = city.dataFindings;
        const hasDiscovery = discovery && Object.hasOwn(discovery, 'registryFound')
            && (discovery.registryFound === null || typeof discovery.registryFound === 'boolean');
        const registryFound = sourceIds.length || verifiedSample ? true
            : hasDiscovery ? discovery.registryFound
                : status === 'no_verified_open_endpoint_after_attempts' ? false : null;
        const rankedDates = evidenceDates.sort((a, b) => b.date.localeCompare(a.date));
        const meaningfulVerifiedSource = sourceRows.some(source =>
            typeof source.verificationStatus === 'string' && source.verificationStatus.startsWith('verified_')
        );
        const hasCheck = evidenceFiles.some(file => readEvidence(repoRoot, file, warnings) !== null)
            || Boolean(files.length) || meaningfulVerifiedSource
            || sourceRows.some(source => (source.integrationAttempts || []).some(attempt => {
                const text = `${attempt.operation || ''} ${attempt.outcome || ''} ${attempt.detail || ''}`.trim();
                return Boolean(text) && (!attempt.cityId || attempt.cityId === city.cityId);
            }));
        const knownGuessRun = city.cityId === 'geonames:3186886';
        const resultFile = path.join(repoRoot, 'world-parcels/guess-spike/output/sam3-zagreb/results.json');
        let hasRecordedRun = false;
        if (knownGuessRun && existsSync(resultFile)) {
            try {
                const result = JSON.parse(readFileSync(resultFile, 'utf8'));
                hasRecordedRun = Array.isArray(result) ? result.length > 0 : Object.keys(result || {}).length > 0;
            } catch (error) {
                warnings.push(`Could not parse guess-spike results: ${error.message}`);
            }
        }
        const manifestFile = path.join(repoRoot, 'world-parcels/guess-spike/output/sam3-finetune/dataset/manifest.json');
        if (knownGuessRun && existsSync(manifestFile)) {
            try {
                const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
                hasRecordedRun ||= Array.isArray(manifest.samples) && manifest.samples.length > 0;
            } catch (error) {
                warnings.push(`Could not parse guess-spike manifest: ${error.message}`);
            }
        }
        const guessExists = knownGuessRun
            && existsSync(path.join(repoRoot, 'world-parcels/guess-spike/README.md'))
            && hasRecordedRun;
        if (knownGuessRun && !guessExists) warnings.push('Zagreb guess-spike records were not available at report build time');
        return {
            cityId: city.cityId,
            checked: Boolean(hasCheck),
            checkedDate: rankedDates[0]?.date || null,
            checkedDateEvidence: rankedDates[0] || null,
            registryFound,
            registryBasis: discovery?.registryBasis || null,
            verifiedSample,
            sourceIds,
            evidenceUrls: safeUrls([...(discovery?.registryEvidenceUrls || []), ...sourceRows.map(source => source.endpoint)]),
            evidenceFiles,
            impliedParcelsTried: guessExists ? true : null
        };
    });

    const catalogSources = Array.isArray(sourceCatalog?.sources) ? sourceCatalog.sources : [];
    const sourceForAppId = new Map(registry.sources.map(source => [source.sourceId, source]));
    const appCityEvidence = appCities.map(appCity => {
        const appId = appCity.id;
        const linkedCatalogSources = catalogSources.filter(source =>
            Array.isArray(source.cityIds) && source.cityIds.includes(appId)
            && (!appCity.sourceId || source.id === appCity.sourceId)
        );
        const sourceIds = unique(linkedCatalogSources.map(source => source.id));
        const evidenceFiles = [];
        const evidenceDates = [];
        let hasExplicitCityCheck = false;
        let cityBoundEvidence = false;
        let successfulCitySample = false;
        let officialExistenceFound = false;
        const evidenceUrls = [];
        const identity = {
            cityId: `app:${appId}`, appCityId: appId, id: appId,
            name: appCity.name || appCity.label?.split(',')[0], label: appCity.label,
            countryCode: appCity.cc || appCity.countryCode, aliases: [appId]
        };
        const normalizeCityName = text => String(text || '').normalize('NFKC').trim().toLocaleLowerCase();
        const appNameForms = [appCity.name, appCity.label, appCity.label?.replace(/,\s*[^,]+$/, '')]
            .filter(Boolean).map(normalizeCityName);
        const matchingRegistryCities = registry.cities.filter(city => {
            if (city.appCityId === appId) return true;
            return Boolean(city.countryCode === identity.countryCode
                && sourceIds.some(id => (city.sourceIds || []).includes(id))
                && appNameForms.includes(normalizeCityName(city.name)));
        });
        const exactRegistryCity = matchingRegistryCities.length === 1 ? matchingRegistryCities[0] : null;
        if (exactRegistryCity) {
            identity.aliases.push(exactRegistryCity.cityId, exactRegistryCity.name, exactRegistryCity.appCityId);
            for (const file of cityPaths(exactRegistryCity)) {
                if (!evidenceFiles.includes(file)) evidenceFiles.push(file);
                const content = readEvidence(repoRoot, file, warnings);
                if (content !== null && !rootConflictsWithCity(content, identity)) {
                    hasExplicitCityCheck = true;
                    cityBoundEvidence ||= evidenceNamesCity(content, identity);
                }
                evidenceDates.push(...actualDates(content, file, '$', [], identity));
            }
        }

        for (const catalogSource of linkedCatalogSources) {
            if (catalogSource.endpoint) evidenceUrls.push(catalogSource.endpoint);
            const source = sourceForAppId.get(catalogSource.id);
            const additional = source?.liveIntegration?.additionalCityEvidence?.[appId];
            const primaryFile = source?.liveIntegration?.evidenceFile || catalogSource.evidenceFile;
            const sourceFiles = [];
            if (additional) sourceFiles.push(additional);
            else if (primaryFile && (catalogSource.cityIds.length === 1 || catalogSource.cityIds[0] === appId)) sourceFiles.push(primaryFile);
            for (const file of unique(sourceFiles)) {
                if (!evidenceFiles.includes(file)) evidenceFiles.push(file);
                const content = readEvidence(repoRoot, file, warnings);
                const designatedPrimary = catalogSource.cityIds.length === 1 || catalogSource.cityIds[0] === appId;
                const scopedFile = content !== null && !rootConflictsWithCity(content, identity)
                    && (evidenceNamesCity(content, identity) || designatedPrimary || Boolean(additional));
                if (scopedFile) {
                    hasExplicitCityCheck = true;
                    cityBoundEvidence = true;
                }
                evidenceDates.push(...actualDates(content, file, '$', [], identity));
            }
            if (!additional && catalogSource.evidenceFile && !sourceFiles.includes(catalogSource.evidenceFile)) {
                const sharedContent = readEvidence(repoRoot, catalogSource.evidenceFile, warnings);
                if (sharedContent !== null && evidenceNamesCity(sharedContent, identity)) {
                    evidenceFiles.push(catalogSource.evidenceFile);
                    hasExplicitCityCheck = true;
                    cityBoundEvidence = true;
                    evidenceDates.push(...actualDates(sharedContent, catalogSource.evidenceFile, '$', [], identity));
                }
            }
            for (const [index, attempt] of (source?.integrationAttempts || []).entries()) {
                const explicitTarget = attempt.cityId || attempt.city_id;
                const attemptText = `${attempt.operation || ''} ${attempt.detail || ''}`.toLocaleLowerCase();
                const targetsCity = explicitTarget ? explicitTarget === appId
                    : attemptText.includes(appId.toLocaleLowerCase());
                if (!targetsCity) continue;
                hasExplicitCityCheck ||= Boolean(attempt.operation || attempt.outcome || attempt.detail);
                successfulCitySample ||= attempt.outcome === 'success';
                const date = normalizeDate(attempt.checkedAt);
                if (date) evidenceDates.push({ date, path: attempt.evidenceFile || null, field: `integrationAttempts[${index}].checkedAt` });
                if (attempt.evidenceFile && !evidenceFiles.includes(attempt.evidenceFile)) {
                    evidenceFiles.push(attempt.evidenceFile);
                    const content = readEvidence(repoRoot, attempt.evidenceFile, warnings);
                    if (content !== null && !rootConflictsWithCity(content, identity) && evidenceNamesCity(content, identity)) cityBoundEvidence = true;
                    evidenceDates.push(...actualDates(content, attempt.evidenceFile, '$', [], identity));
                }
            }
        }

        // Belgrade's official-cadastre discovery is documented outside the runtime source catalog.
        if (appId === 'belgrade') {
            const file = 'research/db-city-belgrade-live-2026-10-03.json';
            evidenceFiles.push(file);
            const content = readEvidence(repoRoot, file, warnings);
            if (content && content.cityId === 'belgrade' && typeof content.decision === 'string' && content.authority && typeof content.authority === 'object') {
                hasExplicitCityCheck = true;
                officialExistenceFound = /official cadastral map\/data existence is established/i.test(content.decision);
                const date = normalizeDate(content.assessedAt);
                if (date) evidenceDates.push({ date, path: file, field: '$.assessedAt' });
                for (const url of [content.authority.officialGeoSrbijaPage, content.authority.officialeCadastrePage]) {
                    if (url) evidenceUrls.push(url);
                }
            }
        }

        evidenceDates.sort((a, b) => b.date.localeCompare(a.date));
        const hasVerifiedSample = linkedCatalogSources.some(catalogSource => {
            const source = sourceForAppId.get(catalogSource.id);
            const explicitlyTargetsCity = source?.verifiedCityIds?.includes(appId)
                || source?.liveIntegration?.cityIds?.includes(appId)
                || Boolean(source?.liveIntegration?.additionalCityEvidence?.[appId]);
            return explicitlyTargetsCity && (cityBoundEvidence || successfulCitySample)
                && typeof source?.verificationStatus === 'string' && source.verificationStatus.startsWith('verified_');
        });
        return {
            cityId: `app:${appId}`,
            checked: Boolean(hasExplicitCityCheck || evidenceDates.length),
            checkedDate: evidenceDates[0]?.date || null,
            checkedDateEvidence: evidenceDates[0] || null,
            registryFound: officialExistenceFound || sourceIds.length || hasVerifiedSample ? true : null,
            verifiedSample: hasVerifiedSample,
            sourceIds,
            evidenceUrls: safeUrls(evidenceUrls),
            evidenceFiles: unique(evidenceFiles),
            impliedParcelsTried: null
        };
    });

    const probes = new Map((registry.countryProbes || []).map(probe => [probe.countryCode, probe]));
    const countryCoverage = new Map((registry.countryCoverage || []).map(row => [row.countryCode, row]));
    const subnational = new Map((registry.subnationalCoverage || []).map(row => [row.countryCode, row]));
    const countryCodes = unique([
        ...probes.keys(), ...countryCoverage.keys(), ...subnational.keys()
    ]).sort();
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
        const evidenceFiles = unique([
            ...recordFiles(probe, ['evidenceFile', 'retryFile', 'latestAssessmentFile', 'europeFile']),
            ...recordFiles(coverage, ['evidenceFile'])
        ]);
        const dateEvidence = [];
        const probeDate = normalizeDate(probe?.checkedAt);
        if (probeDate) dateEvidence.push({ date: probeDate, path: probe.evidenceFile || null, field: 'countryProbes.checkedAt' });
        for (const file of evidenceFiles) dateEvidence.push(...actualDates(readEvidence(repoRoot, file, warnings), file));
        dateEvidence.sort((a, b) => b.date.localeCompare(a.date));
        const evidenceUrls = safeUrls([
            probe?.inspireRecordUrl,
            ...(probe?.sources || []).map(source => source.endpoint),
            ...(coverage?.sources || []).map(source => source.endpoint)
        ]);
        return {
            countryCode,
            checked: Boolean(probeDate || dateEvidence.length),
            checkedDate: dateEvidence[0]?.date || null,
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
                    evidenceFile: region.evidenceFile || null
                }))
            } : null,
            parentSource,
            evidenceUrls,
            evidenceFiles,
            probeStatus: status
        };
    });

    return { cities: cityEvidence, appCities: appCityEvidence, countries, warnings: unique(warnings) };
}
