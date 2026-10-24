import { openDatabaseParcelSource, databaseSourceHandler } from '../parcels/database-sources.js';
export * from '../parcels/ba-database-source.js';

export function setupParcelBaRoute(app, pool) {
    const reader = openDatabaseParcelSource('parcel-ba', pool);
    app.get('/parcel-ba', databaseSourceHandler(reader, 'lookup'));
}
