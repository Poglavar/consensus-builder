import { openDatabaseParcelSource, databaseSourceHandler } from '../parcels/database-sources.js';
export * from '../parcels/bg-database-source.js';

export function setupParcelBgRoute(app, pool) {
    const reader = openDatabaseParcelSource('parcel-bg', pool);
    app.get('/parcel-bg', databaseSourceHandler(reader, 'lookup'));
}
