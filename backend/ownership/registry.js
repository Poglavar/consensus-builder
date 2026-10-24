// Ownership adapter registry: maps a parcel source id to the adapter or linked endpoint declared
// for it in source-catalog.json, and returns every answer as a validated contract record.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { HttpError } from '../utils/helpers.js';
import { buildOwnershipRecord } from './contract.js';
import { httpAdapter, validateHttpDeclaration } from './adapters/http.js';
import { hrOssAdapter } from './adapters/hr-oss.js';
import { arCabaAdapter } from './adapters/ar-caba.js';
import { rsBgAdapter } from './adapters/rs-bg.js';
import { usNycAdapter } from './adapters/us-nyc.js';
import { siGursAdapter } from './adapters/si-gurs.js';
const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');

export const BUILTIN_OWNERSHIP_ADAPTERS = Object.freeze(Object.fromEntries(
    [hrOssAdapter, arCabaAdapter, rsBgAdapter, usNycAdapter, siGursAdapter].map(adapter => [adapter.name, adapter])
));

const DECLARATION_KEYS = ['adapter', 'http', 'attribution', 'licence'];
let defaultCatalog;
function loadCatalog() {
    defaultCatalog ||= JSON.parse(readFileSync(new URL('../../frontend/data/source-catalog.json', import.meta.url), 'utf8'));
    return defaultCatalog;
}

// Reads every `ownership` block of the catalog's sources and database sources. Throws on a bad
// declaration so a broken registration stops the server at startup instead of failing per request.
export function ownershipDeclarations(catalog, adapters = BUILTIN_OWNERSHIP_ADAPTERS) {
    const declarations = new Map();
    for (const source of [...(catalog.sources || []), ...(catalog.databaseSources || [])]) {
        const declaration = source.ownership;
        if (declaration === undefined || declaration === false) continue;
        const fail = message => { throw new Error(`Ownership declaration for ${source.id}: ${message}`); };
        if (!declaration || typeof declaration !== 'object' || Array.isArray(declaration)) fail('must be an object or false');
        const extra = Object.keys(declaration).filter(key => !DECLARATION_KEYS.includes(key));
        if (extra.length) fail(`unknown field(s) ${extra.join(', ')}`);
        if (('adapter' in declaration) === ('http' in declaration)) fail('declare exactly one of adapter or http');
        if ('adapter' in declaration && !adapters[declaration.adapter]) fail(`unknown adapter "${declaration.adapter}"`);
        if ('http' in declaration) validateHttpDeclaration(declaration.http, source.id);
        if (typeof declaration.attribution !== 'string' || !declaration.attribution.trim()) fail('attribution is required');
        if (declaration.licence !== undefined && declaration.licence !== null && typeof declaration.licence !== 'string') fail('licence must be a string or null');
        if (declarations.has(source.id)) fail('source id is declared twice');
        declarations.set(source.id, declaration);
    }
    return declarations;
}

// Declarations remain public source configuration; pools, transports and injected adapters are
// backend context and never become source catalogue data.
export function registerOwnershipSources(catalog = loadCatalog(), adapters = BUILTIN_OWNERSHIP_ADAPTERS) {
    const declarations = ownershipDeclarations(catalog, adapters);
    return SourceRuntime.createRegistry({
        abstraction: 'ownership',
        adapters: Object.fromEntries([...new Set([...Object.keys(adapters), 'http'])].map(id => [id, {
            custom: id === 'http',
            create: (declaration, context) => ({
                lookup: parcelId => (declaration.http ? httpAdapter : (context.adapters || BUILTIN_OWNERSHIP_ADAPTERS)[id]).lookup({
                    parcelId, pool: context.pool, fetchImpl: context.fetchImpl, declaration
                })
            })
        }])),
        sources: [...declarations].map(([id, declaration]) => SourceRuntime.source(
            'ownership', declaration.http ? 'http' : declaration.adapter, declaration, { id })),
        required: ['lookup']
    });
}
export const ownershipSourceRegistry = registerOwnershipSources();

export function createOwnershipRegistry({ catalog = loadCatalog(), adapters = BUILTIN_OWNERSHIP_ADAPTERS, fetchImpl } = {}) {
    const registry = catalog === loadCatalog() && adapters === BUILTIN_OWNERSHIP_ADAPTERS
        ? ownershipSourceRegistry : registerOwnershipSources(catalog, adapters);
    const declarations = new Map(registry.sources().map(source => [source.id, source.config]));
    return {
        sourceIds: () => [...declarations.keys()],
        // null when the source knows no such parcel; throws HttpError for unregistered sources and
        // malformed ids, OwnershipContractError when an answer does not fit the contract.
        async lookup(sourceId, parcelId, { pool } = {}) {
            const declaration = declarations.get(sourceId);
            if (!declaration) {
                throw Object.assign(new HttpError(404, 'No ownership adapter is registered for this parcel source.'), { code: 'no-ownership-adapter' });
            }
            const answer = await registry.open(sourceId, { adapters, pool, fetchImpl }).lookup(parcelId);
            if (answer === null || answer === undefined) return null;
            return buildOwnershipRecord(answer, {
                sourceId, parcelId, attribution: declaration.attribution, licence: declaration.licence ?? null
            });
        }
    };
}
