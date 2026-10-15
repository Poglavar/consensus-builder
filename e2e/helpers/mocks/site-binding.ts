// Answer the binding API at the network boundary using only the fixture cadastre. UI tests assert
// the requested site and resulting declaration; cadastral tolerance edge cases have backend tests.
import { createRequire } from 'node:module';
import path from 'node:path';
import { sampleParcels } from './parcel-data';

const backendRequire = createRequire(path.resolve(__dirname, '../../../backend/package.json'));
const turf = backendRequire('@turf/turf');

export function fixtureSiteBinding(site: any, toleranceM = 0, cadastre: any[] = sampleParcels.features) {
  if (!site || !['Polygon', 'MultiPolygon'].includes(site.type)) throw new Error('Binding request must carry a polygon site');
  const feature = turf.feature(site);
  let open = feature;
  const parcels = cadastre.flatMap(parcel => {
    const intersection = turf.intersect(feature, parcel);
    if (open) open = turf.difference(open, parcel);
    const overlapM2 = intersection ? turf.area(intersection) : 0;
    if (overlapM2 < 0.01) return [];
    const box = turf.bbox(intersection);
    const width = turf.distance([box[0], box[1]], [box[2], box[1]], { units: 'meters' });
    const height = turf.distance([box[0], box[1]], [box[0], box[3]], { units: 'meters' });
    return [{ parcelId: parcel.properties.parcelId, overlapM2, intrusionM: Math.min(width, height) }];
  });
  const unsurveyedM2 = open ? turf.area(open) : 0;
  return {
    parcels, touched: [], toleranceM, coverage: unsurveyedM2 > 0.01 ? 'partial' : 'complete',
    unsurveyedM2, siteM2: turf.area(feature), source: 'server:e2e-fixture-cadastre',
  };
}
