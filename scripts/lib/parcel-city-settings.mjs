// Current durable contract: one settings.json per WUP numeric code. Each file owns one or more
// app-city bindings plus source descriptors scoped to those bindings; apply merges shared-source
// city scopes back into the executable catalog before rewriting runtime configuration.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { browserParcelFactories } from '../../backend/parcels/browser-source-runtime.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '../..');
const jsonReplacer = (_key, value) => value === Infinity ? { $number: 'Infinity' } : value === -Infinity ? { $number: '-Infinity' } : value;
const jsonReviver = (_key, value) => value && value.$number === 'Infinity' ? Infinity : value && value.$number === '-Infinity' ? -Infinity : value;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function recoverQualifiedSettings(root = DEFAULT_ROOT, artifactRoots = []) {
    const recovered = [], skipped = [];
    for (const artifactRoot of artifactRoots) {
        const candidateFile = path.join(artifactRoot, 'candidate.json');
        const evidenceDir = fs.existsSync(path.join(artifactRoot, 'evidence')) ? path.join(artifactRoot, 'evidence') : artifactRoot;
        const qualificationFile = path.join(evidenceDir, 'qualification.json');
        const cacheFile = path.join(evidenceDir, 'full-safe.geojson');
        try {
            const candidateBytes = fs.readFileSync(candidateFile), cacheBytes = fs.readFileSync(cacheFile);
            const candidate = JSON.parse(candidateBytes), qualification = JSON.parse(fs.readFileSync(qualificationFile, 'utf8'));
            const cache = JSON.parse(cacheBytes), descriptor = candidate.descriptor;
            const code = String(candidate.city?.code || '');
            if (qualification.status !== 'technical-qualified'
                || qualification.candidateSha256 !== sha256(candidateBytes)
                || qualification.cacheSha256 !== sha256(cacheBytes)
                || qualification.cityCode !== code || qualification.sourceId !== descriptor?.id
                || !['classification', 'exactIds', 'stableGeometry'].every(key => qualification.checks?.[key]?.passed === true)
                || candidate.sourceClassification?.isParcel !== true
                || !descriptor?.id || !descriptor?.adapter || !/^https?:\/\//i.test(descriptor.endpoint || '')
                || !Array.isArray(candidate.city?.point) || candidate.city.point.length < 2
                || !Number.isFinite(candidate.city.point[0]) || !Number.isFinite(candidate.city.point[1])
                || cache.type !== 'FeatureCollection' || !Array.isArray(cache.features)
                || !cache.features.some(feature => ['Polygon', 'MultiPolygon'].includes(feature?.geometry?.type)
                    && Array.isArray(feature.geometry.coordinates) && feature.geometry.coordinates.length)) {
                skipped.push({ artifactRoot, reason: 'qualification evidence is incomplete or inconsistent' }); continue;
            }
            if (!browserParcelFactories[descriptor.adapter]) {
                skipped.push({ artifactRoot, reason: `unsupported adapter: ${descriptor.adapter}` }); continue;
            }
            if (!/^\d+$/.test(code)) { skipped.push({ artifactRoot, reason: 'invalid city code' }); continue; }
            const settingsFile = path.join(root, 'world-parcels/cities', code, 'settings.json');
            let existing = null;
            try { existing = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch {}
            if (existing && isBoundWorkingSettings(existing, code)) {
                skipped.push({ artifactRoot, reason: 'city already has bound working settings' }); continue;
            }
            const row = { schemaVersion: 1, cityCode: code, name: candidate.city.name || descriptor.cityName || code,
                countryCode: candidate.city.countryCode || descriptor.countryCode,
                point: [candidate.city.point[1], candidate.city.point[0]], bindings: [], sources: [cleanDescriptor(descriptor)] };
            fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
            fs.writeFileSync(settingsFile, `${JSON.stringify(row, jsonReplacer, 2)}\n`);
            recovered.push(code);
        } catch (error) { skipped.push({ artifactRoot, reason: error.message }); }
    }
    return { recovered, skipped };
}

function isBoundWorkingSettings(settings, code) {
    if (settings?.schemaVersion !== 1 || String(settings.cityCode) !== String(code)
        || !Array.isArray(settings.bindings) || !settings.bindings.length || !Array.isArray(settings.sources)) return false;
    const ids = new Set(settings.sources.map(source => source?.id).filter(Boolean));
    return settings.bindings.some(binding => binding?.appCityId && binding.runtimeConfig?.id === binding.appCityId
        && sourceIds(binding.runtimeConfig).some(id => ids.has(id)));
}

function objectLiteralAt(source, marker) {
    const start = source.indexOf(marker);
    if (start < 0) throw new Error(`Missing ${marker}`);
    const open = source.indexOf('{', start + marker.length);
    let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        const next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`Unclosed ${marker}`);
}

export function parseCityConfigs(source) {
    const literal = objectLiteralAt(source, 'const CITY_CONFIGS =');
    const context = vm.createContext({ SHARED_DEFAULT_ZOOM: 19, Infinity, NaN,
        exploreView: { lat: 30, lon: 15, zoom: 3 },
        translateCityText: (_key, fallback) => fallback, formatCityText: value => value });
    return JSON.parse(JSON.stringify(vm.runInContext(`(${literal})`, context, { timeout: 1000 }), jsonReplacer), jsonReviver);
}

function cityCodeMap(demographics) {
    const map = new Map();
    for (const row of demographics?.cities || []) {
        const code = String(row.wupCityCode || row.id?.replace(/^wup2025:/, '') || '');
        for (const id of row.appCityIds || []) map.set(id, code);
    }
    return map;
}

function sourceIds(config) {
    const ids = new Set();
    for (const value of [config.parcels?.sourceId, config.parcels?.liveSource?.sourceId,
        ...(config.parcels?.sources || []).map(source => source.sourceId || source.id)]) {
        if (typeof value === 'string' && value) ids.add(value);
    }
    return [...ids];
}

function cleanDescriptor(descriptor) {
    const clean = structuredClone(descriptor);
    const strip = value => {
        if (Array.isArray(value)) return value.map(strip).filter(item => item !== undefined);
        if (typeof value === 'string') {
            if (/^https?:\/\//i.test(value)) return value;
            // Blank strings and whitespace are meaningful provider filter values.
            // Only descriptive strings containing a retired archive path are cleaned.
            if (!/\b(?:[\w.-]+\/)*research\/[\w./-]+/.test(value)) return value;
            return value.replace(/\b(?:[\w.-]+\/)*research\/[\w./-]+/g, '').replace(/\bsee\s+and\b/gi, '').replace(/\bsee\s+(?=[,.;])/gi, '').replace(/\s+([,.;])/g, '$1').replace(/\s{2,}/g, ' ').trim() || undefined;
        }
        if (!value || typeof value !== 'object') return value;
        for (const [key, item] of Object.entries(value)) {
            if (/^(evidenceFile|qualificationEvidence|additionalCityEvidence|qualityEvidenceFile)$/i.test(key)) delete value[key];
            else {
                const cleaned = strip(item);
                if (cleaned === undefined) delete value[key]; else value[key] = cleaned;
            }
        }
        return value;
    };
    return strip(clean);
}

function scopeDescriptor(descriptor, appCityId, sourceKind) {
    const scoped = cleanDescriptor(descriptor);
    if (Array.isArray(scoped.cityIds)) scoped.cityIds = [appCityId];
    if (scoped.metricSridByCity && typeof scoped.metricSridByCity === 'object') {
        scoped.metricSridByCity = Object.hasOwn(scoped.metricSridByCity, appCityId)
            ? { [appCityId]: scoped.metricSridByCity[appCityId] } : {};
    }
    if (sourceKind) scoped.sourceKind = sourceKind;
    return scoped;
}

function mergeScopedDescriptor(target, incoming) {
    const targetBase = { ...target, cityIds: undefined, metricSridByCity: undefined, sourceKind: undefined };
    const incomingBase = { ...incoming, cityIds: undefined, metricSridByCity: undefined, sourceKind: undefined };
    if (JSON.stringify(targetBase) !== JSON.stringify(incomingBase)) throw new Error(`Conflicting source descriptor: ${incoming.id}`);
    if (target.cityIds || incoming.cityIds) target.cityIds = [...new Set([...(target.cityIds || []), ...(incoming.cityIds || [])])];
    if (target.metricSridByCity || incoming.metricSridByCity) {
        target.metricSridByCity ||= {};
        for (const [cityId, srid] of Object.entries(incoming.metricSridByCity || {})) {
            if (target.metricSridByCity[cityId] !== undefined && target.metricSridByCity[cityId] !== srid) {
                throw new Error(`Conflicting metric projection for ${incoming.id} in ${cityId}`);
            }
            target.metricSridByCity[cityId] = srid;
        }
    }
}

export function buildCitySettings({ configs, catalog, demographics, codes }) {
    const wanted = codes ? new Set(codes.map(String)) : null;
    const mappedCodes = cityCodeMap(demographics);
    const byCode = new Map((catalog.sources || []).flatMap(source =>
        (source.cityIds || []).map(cityId => [String(cityId), source])));
    const databaseSources = new Map((catalog.databaseSources || []).map(source => [source.id, source]));
    const grouped = new Map();
    for (const config of Object.values(configs)) {
        const code = String(config.wupCityCode || mappedCodes.get(config.id) || '');
        if (!/^\d+$/.test(code) || (wanted && !wanted.has(code))) continue;
        const ids = sourceIds(config);
        const cityDescriptor = byCode.get(config.id);
        if (config.parcels?.source === 'parcel-source' && !ids.length && cityDescriptor) ids.push(cityDescriptor.id);
        if (config.parcels?.source === 'parcel-source' && !ids.length) {
            throw new Error(`No validated source catalog binding for ${config.id}`);
        }
        const descriptors = ids.map(id => {
            const descriptor = (catalog.sources || []).find(item => item.id === id) || (id === 'parcel-source' ? cityDescriptor : null);
            if (!descriptor) throw new Error(`Configured source ${id} for ${config.id} is absent from source catalog`);
            return scopeDescriptor(descriptor, config.id);
        });
        const databaseDescriptor = databaseSources.get(config.parcels?.source);
        if (databaseDescriptor) descriptors.push(scopeDescriptor(databaseDescriptor, config.id, 'database'));
        const row = grouped.get(code) || { schemaVersion: 1, cityCode: code,
            name: config.label || config.name || config.id,
            ...(config.country ? { country: config.country } : {}),
            ...(config.map?.defaultCenter ? { point: [...config.map.defaultCenter] } : {}),
            bindings: [], sources: [] };
        row.bindings.push({ appCityId: config.id, runtimeConfig: structuredClone(config) });
        const sourceMap = new Map(row.sources.map(source => [source.id, source]));
        for (const source of descriptors) {
            if (sourceMap.has(source.id)) mergeScopedDescriptor(sourceMap.get(source.id), source);
            else sourceMap.set(source.id, source);
        }
        row.sources = [...sourceMap.values()];
        grouped.set(code, row);
    }
    if (wanted) {
        const found = new Set(grouped.keys());
        const missing = [...wanted].filter(code => !found.has(code));
        if (missing.length) throw new Error(`No configured WUP city for code(s): ${missing.join(', ')}`);
    }
    return [...grouped.values()].sort((a, b) => Number(a.cityCode) - Number(b.cityCode));
}

export function exportCitySettings(root = DEFAULT_ROOT, options = {}) {
    const configs = parseCityConfigs(fs.readFileSync(path.join(root, 'frontend/js/city-config.js'), 'utf8'));
    const catalog = JSON.parse(fs.readFileSync(path.join(root, 'backend/parcels/source-catalog.json'), 'utf8'));
    const demographics = JSON.parse(fs.readFileSync(path.join(root, 'world-parcels/report/city-demographics.json'), 'utf8'));
    const rows = buildCitySettings({ configs, catalog, demographics, codes: options.codes });
    for (const row of rows) {
        const file = path.join(root, 'world-parcels/cities', row.cityCode, 'settings.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${JSON.stringify(row, jsonReplacer, 2)}\n`);
        const readback = JSON.parse(fs.readFileSync(file, 'utf8'), jsonReviver);
        if (readback.cityCode !== row.cityCode || !Array.isArray(readback.bindings)) throw new Error(`Settings readback failed: ${file}`);
    }
    return rows.map(row => path.join('world-parcels/cities', row.cityCode, 'settings.json'));
}

function matchingObjectEnd(source, open) {
    let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
    for (let i = open; i < source.length; i++) {
        const ch = source[i], next = source[i + 1];
        if (lineComment) { if (ch === '\n') lineComment = false; continue; }
        if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
        if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
        if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
        if (ch === '{') depth++;
        if (ch === '}') { depth--; if (depth === 0) return i + 1; }
    }
    throw new Error('Unclosed city config object');
}

function jsString(value, level = 12) {
    if (typeof value === 'string') return "'" + value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n') + "'";
    if (value === Infinity) return 'Infinity';
    if (value === -Infinity) return '-Infinity';
    if (value === null || typeof value !== 'object') return String(value);
    if (Array.isArray(value)) return `[${value.map(item => jsString(item, level)).join(', ')}]`;
    const entries = Object.entries(value);
    if (!entries.length) return '{}';
    const key = name => /^[A-Za-z_$][\w$]*$/.test(name) ? name : jsString(name);
    return '{\n' + entries.map(([name, item]) => ' '.repeat(level + 4) + key(name) + ': ' + jsString(item, level + 4)).join(',\n') + '\n' + ' '.repeat(level) + '}';
}

function replaceCityParcels(source, cityId, parcels) {
    const escaped = cityId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cityMatch = new RegExp(`^ {8}${escaped}:\\s*\\{`, 'm').exec(source);
    if (!cityMatch) throw new Error(`Cannot locate app city config ${cityId}`);
    const cityOpen = cityMatch.index + cityMatch[0].lastIndexOf('{');
    const cityEnd = matchingObjectEnd(source, cityOpen);
    const block = source.slice(cityOpen, cityEnd);
    const property = /\bparcels\s*:\s*\{/m.exec(block);
    if (!property) throw new Error(`App city ${cityId} has no parcels config`);
    const parcelOpen = block.indexOf('{', property.index + property[0].lastIndexOf(':'));
    const parcelEnd = matchingObjectEnd(block, parcelOpen);
    const updated = block.slice(0, parcelOpen) + jsString(parcels) + block.slice(parcelEnd);
    return source.slice(0, cityOpen) + updated + source.slice(cityEnd);
}

function validateSettings(rows, catalog) {
    const appIds = new Set(), cityCodes = new Set(), descriptors = new Map(), databaseDescriptors = new Map();
    const knownSourceIds = new Set((catalog.sources || []).map(source => source.id));
    const knownDatabaseIds = new Set((catalog.databaseSources || []).map(source => source.id));
    for (const row of rows) {
        if (row.schemaVersion !== 1 || !/^\d+$/.test(String(row.cityCode)) || !Array.isArray(row.sources) || !Array.isArray(row.bindings)) throw new Error(`Invalid city settings contract for ${row.cityCode}`);
        if (cityCodes.has(String(row.cityCode))) throw new Error(`Duplicate WUP city settings: ${row.cityCode}`);
        cityCodes.add(String(row.cityCode));
        const bindings = row.bindings;
        const rowSources = new Map();
        for (const descriptor of row.sources) {
            if (rowSources.has(descriptor.id)) mergeScopedDescriptor(rowSources.get(descriptor.id), descriptor);
            else rowSources.set(descriptor.id, structuredClone(descriptor));
        }
        for (const binding of bindings) {
            if (!binding.appCityId || !binding.runtimeConfig || binding.runtimeConfig.id !== binding.appCityId) throw new Error(`Invalid app city binding for WUP ${row.cityCode}`);
            if (appIds.has(binding.appCityId)) throw new Error(`Duplicate app city binding: ${binding.appCityId}`);
            appIds.add(binding.appCityId);
            const byId = rowSources;
            for (const id of sourceIds(binding.runtimeConfig)) if (!byId.has(id)) throw new Error(`Missing source descriptor ${id} for ${binding.appCityId}`);
            const parcelSource = binding.runtimeConfig.parcels?.source;
            if (parcelSource && parcelSource !== 'parcel-source' && !knownDatabaseIds.has(parcelSource)
                && !knownSourceIds.has(parcelSource) && !byId.has(parcelSource)) {
                throw new Error(`Missing parcel source binding ${parcelSource} for ${binding.appCityId}`);
            }
            for (const descriptor of byId.values()) {
                if (!descriptor.id || !(descriptor.adapter || descriptor.ownership?.adapter)) throw new Error(`Invalid source descriptor for ${binding.appCityId}`);
                const target = descriptor.sourceKind === 'database' ? databaseDescriptors : descriptors;
                if (target.has(descriptor.id)) mergeScopedDescriptor(target.get(descriptor.id), descriptor);
                else target.set(descriptor.id, structuredClone(descriptor));
            }
        }
    }
    return { appIds, descriptors, databaseDescriptors };
}

export function applyCitySettings(root = DEFAULT_ROOT, options = {}) {
    const dir = path.join(root, 'world-parcels/cities');
    const codes = options.codes?.map(String) || fs.readdirSync(dir, { withFileTypes: true })
        .filter(item => item.isDirectory() && /^\d+$/.test(item.name)
            && fs.existsSync(path.join(dir, item.name, 'settings.json'))).map(item => item.name);
    const rows = codes.map(code => JSON.parse(fs.readFileSync(path.join(dir, code, 'settings.json'), 'utf8'), jsonReviver));
    const configFile = path.join(root, 'frontend/js/city-config.js');
    const catalogFile = path.join(root, 'backend/parcels/source-catalog.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    const { appIds, descriptors, databaseDescriptors } = validateSettings(rows, catalog);
    let configSource = fs.readFileSync(configFile, 'utf8');
    const configs = parseCityConfigs(configSource);
    for (const id of appIds) if (!configs[id]) throw new Error(`Settings reference missing app city ${id}`);
    for (const row of rows) for (const binding of row.bindings) {
        if (!binding.runtimeConfig.parcels || !configs[binding.appCityId].parcels) throw new Error(`Missing parcel runtime config for ${binding.appCityId}`);
        if (JSON.stringify(configs[binding.appCityId].parcels, jsonReplacer)
            === JSON.stringify(binding.runtimeConfig.parcels, jsonReplacer)) continue;
        configSource = replaceCityParcels(configSource, binding.appCityId, binding.runtimeConfig.parcels);
    }
    const mergeCatalogRecord = (prior, incoming) => {
        const cleanPrior = cleanDescriptor(prior);
        return { ...cleanPrior, ...incoming,
            ...(prior.cityIds || incoming.cityIds ? { cityIds: [...new Set([...(prior.cityIds || []), ...(incoming.cityIds || [])])] } : {}),
            ...(prior.metricSridByCity || incoming.metricSridByCity ? { metricSridByCity: { ...(prior.metricSridByCity || {}), ...(incoming.metricSridByCity || {}) } } : {}) };
    };
    const existing = new Map((catalog.sources || []).map(source => [source.id, source]));
    for (const [id, descriptor] of descriptors) existing.set(id, mergeCatalogRecord(existing.get(id) || {}, descriptor));
    catalog.sources = [...existing.values()];
    const database = new Map((catalog.databaseSources || []).map(source => [source.id, source]));
    for (const [id, descriptor] of databaseDescriptors) {
        const { sourceKind, ...record } = descriptor;
        database.set(id, mergeCatalogRecord(database.get(id) || {}, record));
    }
    catalog.databaseSources = [...database.values()];
    fs.writeFileSync(configFile, configSource);
    fs.writeFileSync(catalogFile, `${JSON.stringify(catalog, null, 2)}\n`);
    return { citySettings: rows.length, appCities: appIds.size, sources: descriptors.size, databaseSources: databaseDescriptors.size };
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
    const args = process.argv.slice(2);
    try {
        const apply = args.includes('--apply');
        let root = DEFAULT_ROOT;
        let recoverList = null;
        const codes = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--apply') continue;
            if (args[i] === '--root') { root = path.resolve(args[++i]); continue; }
            if (args[i] === '--recover-qualified-list') { recoverList = path.resolve(args[++i]); continue; }
            if (args[i] === '--codes') { codes.push(...String(args[++i] || '').split(',').filter(Boolean)); continue; }
            if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
            codes.push(...args[i].split(',').filter(Boolean));
        }
        const options = { codes: codes.length ? codes : undefined };
        const result = recoverList ? recoverQualifiedSettings(root, JSON.parse(fs.readFileSync(recoverList, 'utf8')))
            : apply ? applyCitySettings(root, options) : { written: exportCitySettings(root, options).length };
        process.stdout.write(`${JSON.stringify(result)}\n`);
    }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
