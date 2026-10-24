import { openDatabaseParcelSource, databaseSourceHandler } from '../parcels/database-sources.js';
export * from '../parcels/nyc-map-database-source.js';

export function setupParcelNycRoute(app, pool) {
    const reader = openDatabaseParcelSource('parcel-nyc', pool);
    app.get('/parcel-nyc', databaseSourceHandler(reader, 'lookup'));
    app.get('/parcel-nyc/:parcelId/envelope', databaseSourceHandler(reader, 'envelope'));
}
