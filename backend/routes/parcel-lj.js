import { openDatabaseParcelSource, databaseSourceHandler } from '../parcels/database-sources.js';
export * from '../parcels/lj-database-source.js';

export function setupParcelLjRoute(app, pool) {
    const reader = openDatabaseParcelSource('parcel-lj', pool);
    app.get('/parcel-lj', databaseSourceHandler(reader, 'lookup'));
}
