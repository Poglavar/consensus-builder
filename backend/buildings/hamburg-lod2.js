// Hamburg's 3D building model (3D-Stadtmodell LoD2, CityGML) as a building source. The city publishes
// it only as one zip a year (2026: 660 MB, 783 tiles of 1 km, LoD2_32_{E}_{N}_1_HH.gml), so tiles are
// read out of it by HTTP range (remote-zip.js): its directory once, then about 2 MB per tile. EPSG:25832
// (ETRS89 / UTM 32N), heights above sea level (DHHN2016). Sheet "565_5934" is the tile from x 565 km
// and y 5934 km. LGV Hamburg, dl-de/by-2-0.
import { strFromU8 } from 'fflate';
import { createCityGmlSource, kmSheets } from './citygml-source.js';
import { parseCityGml } from './citygml.js';
import { openRemoteZip } from './remote-zip.js';

// The yearly release the source reads; HAMBURG_LOD2_ZIP_URL points it at another.
export const HAMBURG_LOD2_ZIP = process.env.HAMBURG_LOD2_ZIP_URL || 'https://www.daten-hamburg.de/opendata/3d_stadtmodell_lod2/LoD2-DE_HH_2026-04-28.zip';

export const HAMBURG_LOD2 = {
    id: 'hamburg-lod2',
    crs: '+proj=utm +zone=32 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    heightOffsetM: 0,
    // The city centre: 2 MB read, 17.7 MB of GML, 487 buildings, about 1.5 s.
    sheetCache: 6,
    sheetsFor: box => kmSheets(box),
    attribution: '© Freie und Hansestadt Hamburg, LGV (3D-Stadtmodell LoD2, dl-de/by-2-0)'
};

export function createHamburgLod2Provider(options) {
    let archive = null;
    return createCityGmlSource({
        ...HAMBURG_LOD2,
        async readSheet(sheet, { fetchImpl }) {
            archive ??= openRemoteZip(HAMBURG_LOD2_ZIP, { fetchImpl });
            const name = `LoD2_32_${sheet}_1_HH.gml`;
            const entry = (await archive.entries()).find(item => item.name.split('/').pop() === name);
            return entry ? parseCityGml(strFromU8(await archive.read(entry))) : [];
        }
    }, options);
}
