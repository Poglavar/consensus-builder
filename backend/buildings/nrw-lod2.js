// North Rhine-Westphalia's 3D building model (3D-Gebäudemodell LoD2, CityGML) as a building source:
// 1 km tiles in EPSG:25832 (ETRS89 / UTM 32N), heights above sea level (DHHN2016), plain GML files.
// Sheet "356_5645" is the tile from x 356 km and y 5645 km (LoD2_32_356_5645_1_NW.gml). A tile with no
// buildings is a near-empty file; one outside the state is not published. Geobasis NRW, dl-de/zero-2-0.
import { createCityGmlSource } from './citygml-source.js';
import { parseCityGml } from './citygml.js';

export const NRW_LOD2 = {
    id: 'nrw-lod2',
    crs: '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    heightOffsetM: 0,
    // A dense tile is large (central Cologne: 56 MB of GML, 1,594 buildings, about 0.8 s to parse and
    // 9 s to download), so only a few parsed tiles are kept.
    sheetCache: 6,
    sheetUrl: sheet => `https://www.opengeodata.nrw.de/produkte/geobasis/3dg/lod2_gml/lod2_gml/LoD2_32_${sheet}_1_NW.gml`,
    async readSheet(sheet, { fetchImpl }) {
        const response = await fetchImpl(NRW_LOD2.sheetUrl(sheet));
        if (response.status === 404) return [];
        if (!response.ok) throw new Error(`nrw-lod2 sheet ${sheet}: HTTP ${response.status}`);
        return parseCityGml(await response.text());
    },
    sheetsFor([minX, minY, maxX, maxY]) {
        const ids = [];
        for (let x = Math.floor(minX / 1000); x <= Math.floor(maxX / 1000); x++) {
            for (let y = Math.floor(minY / 1000); y <= Math.floor(maxY / 1000); y++) ids.push(`${x}_${y}`);
        }
        return ids;
    },
    attribution: '© Geobasis NRW (3D-Gebäudemodell LoD2, dl-de/zero-2-0)'
};

export function createNrwLod2Provider(options) {
    return createCityGmlSource(NRW_LOD2, options);
}
