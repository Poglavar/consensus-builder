// Survey APIs declare EPSG:3765; author readable lon/lat fixtures, then project their wire data.
const proj4 = require('../../../frontend/vendor/proj4-2.22.0/proj4.js');
const HTRS96 = '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

export function surveyResponse(features: any[]) {
  const project = (coordinates: any[]): any[] => typeof coordinates[0] === 'number'
    ? proj4('EPSG:4326', HTRS96, coordinates)
    : coordinates.map(project);
  return {
    type: 'FeatureCollection',
    truncated: false,
    features: features.map(feature => ({
      ...feature,
      geometry: { ...feature.geometry, coordinates: project(feature.geometry.coordinates) },
    })),
  };
}
