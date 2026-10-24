// Public metadata only: registration is visible here; provider reads keep their own routes.
import { createRequire } from 'node:module';
import '../parcels/sources.js';
import '../parcels/database-sources.js';
import '../buildings/index.js';
import '../buildings/map-source.js';
import '../planning/sources.js';
import '../ownership/registry.js';
import '../buildings/floor-models.js';
import '../imagery/sources.js';

const require = createRequire(import.meta.url);
const SourceRuntime = require('../../frontend/js/source-runtime.js');
const SourceContracts = require('../../frontend/js/source-contracts.js');
require('../../frontend/js/browser-source-readers.js');
require('../../frontend/js/parcels/dgu-live.js');
require('../../frontend/js/overture-tiles.js');
require('../../frontend/js/economic-sources.js');
require('../../frontend/js/imagery-source.js');
require('../../frontend/js/browser-ownership-source.js');
const BROWSER_FAMILIES = new Set(['geocoding', 'imagery', 'terrain-profile', 'transit-alignments', 'economics', 'reality-mesh']);


export function sourceSystemCatalogue() {
    const catalogue = SourceRuntime.catalogue();
    const abstractions = catalogue.abstractions.map(family => ({ ...family, registered: true,
        runtime: family.runtimes.length > 1 ? 'mixed' : family.runtimes[0] || 'server' }));
    const registered = new Set(abstractions.map(family => family.id));
    for (const contract of SourceContracts.all()) {
        if (!BROWSER_FAMILIES.has(contract.id) || registered.has(contract.id)) continue;
        abstractions.push({ id: contract.id, contract, runtime: 'browser', registered: false,
            adapters: contract.adapters.map(adapter => ({ ...adapter, contract: adapter, registered: false })), sources: [] });
    }
    return { ...catalogue, abstractions };
}

export function setupSourceSystemRoutes(app) {
    app.get('/source-system', (_req, res) => res.json(sourceSystemCatalogue()));
    app.get('/source-system/contracts', (_req, res) => res.json({
        schema: 'source-contracts/v1', abstractions: SourceContracts.all()
    }));
    app.get('/source-system/contracts/:abstraction', (req, res) => {
        const contract = SourceContracts.all().find(item => item.id === req.params.abstraction);
        if (!contract) return res.status(404).json({ error: 'Unknown source abstraction.' });
        res.json(contract);
    });
    app.get('/source-system/schemas', (_req, res) => res.json({
        schema: 'source-schemas/v1', schemas: SourceContracts.schemas()
    }));
    app.get('/source-system/schemas/:name', (req, res) => {
        const schemas = SourceContracts.schemas();
        if (!Object.hasOwn(schemas, req.params.name)) return res.status(404).json({ error: 'Unknown source schema.' });
        res.json(schemas[req.params.name]);
    });
}
