// Saxony's 3D building model (3D-Stadtmodell LoD2, CityGML) as a building source: 2 km tiles in
// EPSG:25833 (ETRS89 / UTM 33N), heights above sea level (DHHN2016), one zip per tile holding one GML.
// GeoSN serves them from a public cloud share whose id its download portal names in its app config, so
// the id is read from there (once per source) rather than written here. Sheet "410_5656" is the tile
// from x 410 km and y 5656 km (lod2_33410_5656_2_sn_citygml.zip). GeoSN, dl-de/by-2-0.
import { createCityGmlSource, kmSheets, readZippedCityGml } from './citygml-source.js';

export const SACHSEN_PORTAL_CONFIG = 'https://geoviewer.sachsen.de/mapviewer/resources/apps/produktdownload/app.json';

// The cloud share id of the LoD2 CityGML download in the portal's app config.
export function sachsenShareId(appConfig) {
    const products = appConfig?.bundles?.['geobak-4x-productdownload']?.ProductdownloadController?.productsConfig || [];
    const format = products.find(product => product.name === 'LOD2')?.formats?.find(item => item.name === 'CityGML');
    if (!format?.cloudId) throw new Error('sachsen-lod2: the download portal no longer names a LoD2 CityGML share');
    return format.cloudId;
}

export const SACHSEN_LOD2 = {
    id: 'sachsen-lod2',
    crs: '+proj=utm +zone=33 +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs',
    heightOffsetM: 0,
    // Central Dresden: a 9 MB zip of 70 MB GML, 1,523 buildings, about 0.9 s to parse.
    sheetCache: 4,
    sheetUrl: (share, sheet) => `https://geocloud.landesvermessung.sachsen.de/public.php/dav/files/${share}/lod2_33${sheet}_2_sn_citygml.zip`,
    sheetsFor: box => kmSheets(box, 2),
    attribution: '© GeoSN (3D-Stadtmodell LoD2, dl-de/by-2-0)'
};

export function createSachsenLod2Provider(options) {
    let share = null;
    return createCityGmlSource({
        ...SACHSEN_LOD2,
        async readSheet(sheet, { fetchImpl }) {
            share ??= (async () => {
                const response = await fetchImpl(SACHSEN_PORTAL_CONFIG);
                if (!response.ok) throw new Error(`sachsen-lod2 portal config: HTTP ${response.status}`);
                return sachsenShareId(await response.json());
            })();
            share.catch(() => { share = null; });
            return readZippedCityGml(SACHSEN_LOD2.sheetUrl(await share, sheet), fetchImpl, `sachsen-lod2 sheet ${sheet}`);
        }
    }, options);
}
