// Berlin's 3D building model (3D-Gebäudemodelle LoD2, CityGML 1.0) as a building source: 1 km tiles in
// EPSG:25833 (ETRS89 / UTM 33N), heights above sea level (DHHN2016), one zip per tile holding one
// XML file. Sheet "392_5820" is the tile from x 392 km and y 5820 km (LoD2_392_5820.zip); a tile
// outside the city is not published. Geoportal Berlin, dl-de/zero-2-0.
import { createCityGmlSource, kmSheets, readZippedCityGml } from './citygml-source.js';

export const BERLIN_LOD2 = {
    id: 'berlin-lod2',
    crs: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    heightOffsetM: 0,
    // Alexanderplatz: a 3.5 MB zip of 28 MB XML, 732 buildings, about 0.8 s to parse.
    sheetCache: 6,
    sheetUrl: sheet => `https://gdi.berlin.de/data/a_lod2/atom/LoD2_${sheet}.zip`,
    readSheet: (sheet, { fetchImpl }) => readZippedCityGml(BERLIN_LOD2.sheetUrl(sheet), fetchImpl, `berlin-lod2 sheet ${sheet}`),
    sheetsFor: box => kmSheets(box),
    attribution: '© Geoportal Berlin (3D-Gebäudemodelle LoD2, dl-de/zero-2-0)'
};

export function createBerlinLod2Provider(options) {
    return createCityGmlSource(BERLIN_LOD2, options);
}
