// New York's 3D Building Model (NYC Office of Technology and Innovation, LoD2, 2014 survey) as a
// building source: the city publishes it as one zip of CityGML, which build-nyc-3d-tiles.mjs cuts
// into 1,000 ft tiles of gzipped CityJSON 2.0 on R2. Tiles are in EPSG:2263 (feet), heights in feet
// above NAVD88 (about sea level, so no offset). Sheet "1033_184" is the tile from x 1,033,000 ft and
// y 184,000 ft; a tile with no buildings is not published.
import { createCityGmlSource } from './citygml-source.js';
import { parseCityJson } from './cityjson.js';

export const NYC_TILE_FT = 1000;
// The tile release the source reads (base URL of the release on R2, set when it is uploaded).
export const NYC_3D_RELEASE = process.env.NYC_3D_TILES_URL || 'https://uk-cadastre.urbangametheory.xyz/nyc-3d/2014-v1';

export const NYC_3D = {
    id: 'nyc-3d',
    crs: '+proj=lcc +lat_0=40.1666666666667 +lon_0=-74 +lat_1=41.0333333333333 +lat_2=40.6666666666667 +x_0=300000 +y_0=0 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=us-ft +no_defs',
    heightOffsetM: 0,
    zToMetres: 0.3048006096012192,
    sheetUrl: sheet => `${NYC_3D_RELEASE}/tiles/${sheet}.city.json`,
    async readSheet(sheet, { fetchImpl }) {
        const response = await fetchImpl(NYC_3D.sheetUrl(sheet));
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`nyc-3d tile ${sheet}: HTTP ${response.status}`);
        return parseCityJson(await response.json());
    },
    sheetsFor([minX, minY, maxX, maxY]) {
        const ids = [];
        for (let x = Math.floor(minX / NYC_TILE_FT); x <= Math.floor(maxX / NYC_TILE_FT); x++) {
            for (let y = Math.floor(minY / NYC_TILE_FT); y <= Math.floor(maxY / NYC_TILE_FT); y++) ids.push(`${x}_${y}`);
        }
        return ids;
    },
    attribution: 'NYC 3D Building Model © City of New York, Office of Technology and Innovation (NYC Open Data)'
};

export function createNyc3dProvider(options) {
    return createCityGmlSource(NYC_3D, options);
}
