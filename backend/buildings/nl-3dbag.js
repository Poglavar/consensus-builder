// The 3D BAG (tudelft3d and 3DGI) as a building source for the Netherlands: every BAG building in
// LoD 1.2, 1.3 and 2.2, read as CityJSON from its OGC API per 250 m sheet of EPSG:28992 (RD New, NAP
// heights). Pages hold at most 100 buildings and follow the API's `next` links; its numberMatched
// counts each building twice, so buildings are joined by id. CC BY 4.0.
import { createCityGmlSource } from './citygml-source.js';
import { parseCityJson } from './cityjson.js';

const API = 'https://api.3dbag.nl/collections/pand/items';
const SHEET_M = 250;
const MAX_PAGES = 40;

export const NL_3DBAG = {
    id: 'nl-3dbag',
    crs: '+proj=sterea +lat_0=52.15616055555555 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 '
        + '+ellps=bessel +towgs84=565.417,50.3319,465.552,-0.398957,0.343988,-1.8774,4.0725 +units=m +no_defs',
    // NAP is the Dutch sea-level datum.
    heightOffsetM: 0,
    maxLod: 2.2,
    sheetsFor([minX, minY, maxX, maxY]) {
        const ids = [];
        for (let column = Math.floor(minX / SHEET_M); column <= Math.floor(maxX / SHEET_M); column++) {
            for (let row = Math.floor(minY / SHEET_M); row <= Math.floor(maxY / SHEET_M); row++) ids.push(`${column}_${row}`);
        }
        return ids;
    },
    sheetUrl(sheet) {
        const [column, row] = sheet.split('_').map(Number);
        return `${API}?bbox=${column * SHEET_M},${row * SHEET_M},${(column + 1) * SHEET_M},${(row + 1) * SHEET_M}&limit=100`;
    },
    async readSheet(sheet, { fetchImpl }) {
        const byId = new Map();
        let url = NL_3DBAG.sheetUrl(sheet);
        for (let page = 0; url; page++) {
            if (page >= MAX_PAGES) throw new Error(`nl-3dbag sheet ${sheet}: more than ${MAX_PAGES} pages`);
            const response = await fetchImpl(url);
            if (!response.ok) throw new Error(`nl-3dbag sheet ${sheet}: HTTP ${response.status}`);
            const body = await response.json();
            if (!Array.isArray(body.features)) throw new Error(`nl-3dbag sheet ${sheet}: the answer holds no features`);
            for (const building of parseCityJson(body, { maxLod: NL_3DBAG.maxLod })) byId.set(building.id, withHeights(building));
            url = (body.links || []).find(link => link.rel === 'next')?.href || null;
        }
        return [...byId.values()];
    },
    attribution: '<a href="https://3dbag.nl">3DBAG</a> by tudelft3d and 3DGI · CC BY 4.0'
};

// 3D BAG states heights as attributes of its own: roof top and ground level above NAP, and storeys.
function withHeights(building) {
    const { b3_h_dak_max: roof, b3_h_maaiveld: ground, b3_bouwlagen: storeys } = building.attributes;
    return {
        ...building,
        measuredHeightM: building.measuredHeightM ?? (Number.isFinite(roof) && Number.isFinite(ground) && roof > ground
            ? Math.round((roof - ground) * 100) / 100 : null),
        storeysAboveGround: building.storeysAboveGround ?? (Number.isInteger(storeys) && storeys > 0 ? storeys : null)
    };
}

export function createNl3dbagProvider(options) {
    return createCityGmlSource(NL_3DBAG, options);
}
