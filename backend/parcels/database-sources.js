// Existing imported datasets retain their native read operations and result shapes.
import { createRequire } from 'node:module';
import catalog from '../../frontend/data/source-catalog.json' with { type: 'json' };
import * as oss from './oss-database-source.js';
import * as ba from './ba-database-source.js';
import * as bg from './bg-database-source.js';
import * as lj from './lj-database-source.js';
import * as nyc from './nyc-map-database-source.js';
import { nycDatabaseSource } from './nyc-database-source.js';
const SourceRuntime = createRequire(import.meta.url)('../../frontend/js/source-runtime.js');
const datasets = { 'oss-wfs': oss, 'parcel-ba': ba, 'parcel-bg': bg, 'parcel-lj': lj, 'parcel-nyc': nyc };
const operations = { 'oss-wfs': ['lookup', 'under', 'parcelIds', 'neighbours', 'queryGeometry', 'queryIds'],
    'parcel-ba': ['lookup'], 'parcel-bg': ['lookup'], 'parcel-lj': ['lookup'], 'parcel-nyc': ['lookup', 'envelope'] };
export const databaseParcelSourceRegistry = SourceRuntime.createRegistry({
    abstraction: 'parcels',
    adapters: Object.fromEntries(Object.entries(datasets).map(([id, provider]) => [id, {
        custom: false, required: operations[id],
        create: (_config, { pool }) => ({
            ...(id === 'parcel-nyc' ? nycDatabaseSource(pool) : {}),
            ...Object.fromEntries(operations[id].map(method => [method, input => provider[method](pool, input)]))
        })
    }])),
    sources: catalog.databaseSources.map(descriptor => SourceRuntime.source('parcels', descriptor.id, descriptor))
});
export function openDatabaseParcelSource(id, pool) { return databaseParcelSourceRegistry.open(id, { pool }); }

// Transport translation stays outside the provider. Named routes explicitly bind their source.
export function databaseSourceHandler(reader, method) {
    return async (req, res) => {
        try { return res.json(await reader[method]({ query: req.query, body: req.body, params: req.params })); }
        catch (error) {
            if (error?.databaseSourceFailure) return res.status(error.status).json(error.payload);
            throw error;
        }
    };
}
