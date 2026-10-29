// Vienna's generalised roof model (Generalisiertes Dachmodell, LOD2.1) as a CityGML building source:
// 500 m sheets in EPSG:31256 (MGI / Austria GK East), heights above Wiener Null. Sheet "109082" is
// column 109 (x from 4500 m) and row 082 (y from 341000 m). Stadt Wien, CC BY 4.0.
import { createCityGmlSource } from './citygml-source.js';

export const WIEN_LOD2 = {
    id: 'wien-lod2',
    crs: '+proj=tmerc +lat_0=0 +lon_0=16.33333333333333 +k=1 +x_0=0 +y_0=-5000000 +ellps=bessel '
        + '+towgs84=577.326,90.129,463.919,5.137,1.474,5.297,2.4232 +units=m +no_defs',
    // Wiener Null lies 156.68 m above the Adriatic datum.
    heightOffsetM: 156.68,
    sheetUrl: sheet => `https://www.wien.gv.at/ma41datenviewer/downloads/geodaten/lod2_gml/${sheet}_lod2_gml.zip`,
    sheetsFor([minX, minY, maxX, maxY]) {
        const ids = [];
        for (let column = Math.floor(minX / 500) + 100; column <= Math.floor(maxX / 500) + 100; column++) {
            for (let row = Math.floor((minY - 300000) / 500); row <= Math.floor((maxY - 300000) / 500); row++) {
                ids.push(`${String(column).padStart(3, '0')}${String(row).padStart(3, '0')}`);
            }
        }
        return ids;
    },
    attribution: 'Datenquelle: Stadt Wien – data.wien.gv.at (Generalisiertes Dachmodell LOD2.1, CC BY 4.0)'
};

export function createWienLod2Provider(options) {
    return createCityGmlSource(WIEN_LOD2, options);
}
