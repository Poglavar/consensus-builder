import { openDatabaseParcelSource, databaseSourceHandler } from '../parcels/database-sources.js';
export * from '../parcels/oss-database-source.js';

export function setupParcelsRoute(app, pool) {
    const reader = openDatabaseParcelSource('oss-wfs', pool);
    app.post('/parcels/under', databaseSourceHandler(reader, 'under'));
    app.get('/parcels/parcelIds', databaseSourceHandler(reader, 'parcelIds'));
    app.get('/parcels', databaseSourceHandler(reader, 'lookup'));
    app.get(/^\/parcels\/(.+)\/neighbours$/, databaseSourceHandler(reader, 'neighbours'));
}
