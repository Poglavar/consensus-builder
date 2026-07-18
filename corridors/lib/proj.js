// EPSG:3765 (HTRS96 / Croatia TM) <-> WGS84 conversion helpers.
import proj4 from 'proj4';

proj4.defs('EPSG:3765', '+proj=tmerc +lat_0=0 +lon_0=16.5 +k=0.9999 +x_0=500000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs');

export function toHTRS([lon, lat]) {
    return proj4('EPSG:4326', 'EPSG:3765', [lon, lat]);
}

export function toWGS([x, y]) {
    return proj4('EPSG:3765', 'EPSG:4326', [x, y]);
}
