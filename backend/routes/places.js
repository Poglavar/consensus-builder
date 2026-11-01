import { z } from 'zod';
import { searchOsmPlaces } from '../places/osm-places.js';
import { searchLandmarkGeometry } from '../places/landmark-source.js';

const text = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(160);
const limitSchema = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(20));
function parseBbox(raw) {
    if (typeof raw !== 'string') return null;
    const values = raw.split(',').map(Number);
    if (values.length !== 4 || values.some(value => !Number.isFinite(value))) return null;
    const [west, south, east, north] = values;
    if (west < -180 || east > 180 || south < -90 || north > 90 || east <= west || north <= south || east - west > 0.5 || north - south > 0.5) return null;
    return values;
}
function parseOsmId(raw) {
    return typeof raw === 'string' && /^(node|way|relation)\/[1-9]\d{0,17}$/.test(raw) ? raw : null;
}
function parsePoint(raw) {
    if (typeof raw !== 'string' || !/^-?(?:\d+(?:\.\d*)?|\.\d+),-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)) return null;
    const point = raw.split(',').map(Number);
    return point.every(Number.isFinite) && point[0] >= -180 && point[0] <= 180 && point[1] >= -90 && point[1] <= 90 ? point : null;
}

export function setupPlacesRoute(app, { search = searchOsmPlaces, landmarkGeometry = searchLandmarkGeometry } = {}) {
    app.get('/places/geometry', async (req, res) => {
        res.set?.('Cache-Control', 'no-store');
        const osmId = parseOsmId(req.query.osmId), point = parsePoint(req.query.point);
        if (!osmId || !point) return res.status(400).json({ code: 'invalid_request', message: 'Provide an OSM id and a WGS84 point as longitude,latitude.' });
        try {
            const result = await landmarkGeometry({ osmId, point });
            res.json(result);
        } catch (error) {
            const status = error.status === 400 ? 400 : error.status === 404 ? 404 : 503;
            res.status(status).json({ code: status === 400 ? 'invalid_request' : status === 404 ? 'landmark_not_found' : 'landmark_unavailable',
                message: status === 400 ? 'The landmark geometry parameters are invalid.' : status === 404 ? 'The selected OSM feature was not found near that point.' : 'OpenStreetMap landmark geometry is temporarily unavailable or incomplete.' });
        }
    });
    app.get('/places', async (req, res) => {
        const bbox = parseBbox(req.query.bbox);
        const queryParsed = req.query.q === undefined ? { success: true, data: undefined } : text.safeParse(req.query.q);
        const streetParsed = req.query.street === undefined ? { success: true, data: undefined } : shortText.safeParse(req.query.street);
        const numberParsed = req.query.houseNumber === undefined ? { success: true, data: undefined } : z.string().trim().min(1).max(20).safeParse(req.query.houseNumber);
        const aParsed = req.query.streetA === undefined ? { success: true, data: undefined } : shortText.safeParse(req.query.streetA);
        const bParsed = req.query.streetB === undefined ? { success: true, data: undefined } : shortText.safeParse(req.query.streetB);
        const limitParsed = req.query.limit === undefined ? { success: true, data: 10 } : limitSchema.safeParse(req.query.limit);
        if (!bbox || !queryParsed.success || !streetParsed.success || !numberParsed.success || !aParsed.success || !bParsed.success || !limitParsed.success) {
            return res.status(400).json({ code: 'invalid_request', message: 'Use a valid WGS84 bbox no larger than 0.5 degrees and valid place search parameters.' });
        }
        const hasAddress = streetParsed.data !== undefined || numberParsed.data !== undefined;
        const hasIntersection = aParsed.data !== undefined || bParsed.data !== undefined;
        if ((hasAddress && (!streetParsed.data || !numberParsed.data)) || (hasIntersection && (!aParsed.data || !bParsed.data)) ||
            (Number(hasAddress) + Number(hasIntersection) + Number(queryParsed.data !== undefined) !== 1)) {
            return res.status(400).json({ code: 'invalid_request', message: 'Provide one place name, complete address, or street intersection.' });
        }
        try {
            const result = await search({ bbox, query: queryParsed.data,
                address: hasAddress ? { street: streetParsed.data, houseNumber: numberParsed.data } : undefined,
                intersection: hasIntersection ? [aParsed.data, bParsed.data] : undefined, limit: limitParsed.data });
            res.json(result);
        } catch (error) {
            const status = error.status === 400 ? 400 : 503;
            res.status(status).json({ code: status === 400 ? 'invalid_request' : 'places_unavailable', message: status === 400 ? 'The place search parameters are invalid.' : 'OpenStreetMap place search is temporarily unavailable.' });
        }
    });
}

export const __placesRouteInternals = { parseBbox, parseOsmId, parsePoint };
