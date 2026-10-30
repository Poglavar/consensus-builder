// Baden-Württemberg's 3D building model (3D-Gebäudemodell LoD2, CityGML) as a building source. The LGL
// publishes 2 km zips (LoD2_32_{E}_{N}_2_bw.zip, E odd and N even, in km) of four 1 km GML tiles
// (LoD2_32_{E}_{N}_1_BW.gml); a sheet is one 1 km tile, so only the tiles a box needs are parsed, and
// the last zips read are kept for their neighbours. EPSG:25832 (ETRS89 / UTM 32N), heights above sea
// level (DHHN2016). LGL Baden-Württemberg, dl-de/by-2-0.
import { unzipSync, strFromU8 } from 'fflate';
import { createCityGmlSource, kmSheets } from './citygml-source.js';
import { parseCityGml } from './citygml.js';

// A box at a zip corner needs four zips (about 18 MB each in central Stuttgart).
const ZIPS_KEPT = 4;

// The 2 km zip holding a 1 km sheet.
export function bwZipOf(sheet) {
    const [x, y] = sheet.split('_').map(Number);
    return `${x % 2 ? x : x - 1}_${y - (y % 2)}`;
}

export const BW_LOD2 = {
    id: 'bw-lod2',
    crs: '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    heightOffsetM: 0,
    // Central Stuttgart: an 18 MB zip; its four tiles are 17–50 MB of GML, 500–2,400 buildings and
    // 0.4–1.8 s to parse each.
    sheetCache: 6,
    zipUrl: zip => `https://opengeodata.lgl-bw.de/data/lod2/LoD2_32_${zip}_2_bw.zip`,
    sheetsFor: box => kmSheets(box),
    attribution: '© LGL Baden-Württemberg, www.lgl-bw.de (3D-Gebäudemodell LoD2, dl-de/by-2-0)'
};

export function createBwLod2Provider(options) {
    const zips = new Map(); // zip id → bytes, or null when the LGL does not publish it
    function readZip(zip, fetchImpl) {
        if (!zips.has(zip)) {
            const bytes = (async () => {
                const response = await fetchImpl(BW_LOD2.zipUrl(zip));
                if (response.status === 404) return null;
                if (!response.ok) throw new Error(`bw-lod2 zip ${zip}: HTTP ${response.status}`);
                return new Uint8Array(await response.arrayBuffer());
            })();
            zips.set(zip, bytes);
            bytes.catch(() => zips.delete(zip));
            if (zips.size > ZIPS_KEPT) zips.delete(zips.keys().next().value);
        }
        return zips.get(zip);
    }
    return createCityGmlSource({
        ...BW_LOD2,
        async readSheet(sheet, { fetchImpl }) {
            const bytes = await readZip(bwZipOf(sheet), fetchImpl);
            if (!bytes) return [];
            const name = `LoD2_32_${sheet}_1_BW.gml`;
            const files = unzipSync(bytes, { filter: file => file.name.split('/').pop() === name });
            return Object.values(files).flatMap(file => parseCityGml(strFromU8(file)));
        }
    }, options);
}
