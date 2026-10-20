// Read-only, bounded provider results for the shared Built / Permitted / Proposed experience.
import { validateBounds } from '../parcels/source-contract.js';
import { planningRepresentations, planningParcel, planningRecord, getPlanningSources } from '../planning/sources.js';
import { loadParcelStudy } from '../planning/parcel-study.js';
import { loadParcelEnvelopes } from '../planning/parcel-envelopes.js';

function validCity(city) { return typeof city === 'string' && /^[a-z][a-z0-9_-]{0,79}$/.test(city); }
function validSource(source) { return source === undefined || (typeof source === 'string' && /^[a-z0-9_-]{1,100}$/.test(source)); }

export function setupPlanningRoutes(app, pool, { sources = getPlanningSources(),
    query = (pool, query) => planningRepresentations(pool, query, sources),
    parcelQuery = (pool, query) => planningParcel(pool, query, sources),
    studyQuery = query => loadParcelStudy(query, { sources }),
    envelopeQuery = query => loadParcelEnvelopes(query, { sources }) } = {}) {
    app.get('/planning/envelopes', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { city, source, scenario } = req.query;
        const bbox = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(value => value.trim() ? Number(value) : NaN) : [];
        try {
            if (!validCity(city) || !source || !validSource(source) || !validSource(scenario)) {
                return res.status(400).json({ code: 'invalid-planning-query' });
            }
            validateBounds(bbox, 0.5);
            res.json(await envelopeQuery({ city, source, scenario, bbox }));
        } catch (error) {
            const status = [400, 422].includes(error.status) ? error.status : 503;
            if (status === 503) console.error('[planning-envelopes] Source read failed.');
            res.status(status).json({ code: status === 400 ? 'envelope-area-too-large' : 'planning-source-unavailable' });
        }
    });
    app.get('/planning/study', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const { city, source, scenario, parcel, point } = req.query;
        const coordinates = typeof point === 'string' ? point.split(',').map(value => value.trim() ? Number(value) : NaN) : null;
        if (!validCity(city) || !source || !validSource(source) || !validSource(scenario)
            || Boolean(parcel) === Boolean(point)
            || parcel && (typeof parcel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./~:-]{0,249}$/.test(parcel))
            || point && (!coordinates || coordinates.length !== 2 || !coordinates.every(Number.isFinite)
                || Math.abs(coordinates[0]) > 180 || Math.abs(coordinates[1]) >= 85)) {
            return res.status(400).json({ error: 'Invalid parcel study query.', code: 'invalid-study-query' });
        }
        try { res.json(await studyQuery({ city, source, scenario, parcel, point: coordinates })); }
        catch (error) {
            const status = [400, 422].includes(error.status) ? error.status : 503;
            if (status === 503) console.error(`[${new Date().toISOString()}] [planning-study] Source read failed (${error.code || 'upstream-error'}).`);
            res.status(status).json({ error: 'Parcel study could not be assembled.',
                code: status === 503 ? 'study-source-unavailable' : error.code || 'study-unavailable' });
        }
    });
    app.get('/planning/record', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!validCity(req.query.city) || !req.query.source || !validSource(req.query.source)
            || !validSource(req.query.scenario) || typeof req.query.recordId !== 'string' || req.query.recordId.length > 250) {
            return res.status(400).json({ error: 'Invalid planning record query.' });
        }
        try { res.json(await planningRecord(pool, { city: req.query.city, source: req.query.source, recordId: req.query.recordId, scenario: req.query.scenario }, sources)); }
        catch (error) { console.error('[planning] Source record read failed', error); res.status(error.status === 400 ? 400 : 503).json({ error: 'Planning source is unavailable.' }); }
    });
    app.get('/planning/sources', (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!validCity(req.query.city)) return res.status(400).json({ error: 'Invalid city.' });
        res.json({ city: req.query.city, sources: sources.filter(p => p.descriptor.city === req.query.city).map(p => p.descriptor) });
    });
    app.get('/planning/parcel', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        if (!validCity(req.query.city) || !validSource(req.query.source)
            || typeof req.query.parcel !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(req.query.parcel)) {
            return res.status(400).json({ error: 'Invalid planning parcel query.' });
        }
        try { res.json(await parcelQuery(pool, { city: req.query.city, parcel: req.query.parcel, source: req.query.source })); }
        catch (error) {
            console.error('[planning] Parcel source read failed', error);
            res.status(error.status === 400 ? 400 : 503).json({ error: 'Planning source is unavailable.' });
        }
    });
    app.get('/planning/representations', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const city = req.query.city;
            if (!validCity(city) || !validSource(req.query.source) || !validSource(req.query.scenario)) {
                return res.status(400).json({ error: 'A city is required.', code: 'invalid-planning-query' });
            }
            const bbox = typeof req.query.bbox === 'string' ? req.query.bbox.split(',').map(value => value.trim() ? Number(value) : NaN) : [];
            validateBounds(bbox, 4);
            const limit = req.query.limit === undefined ? 200 : Number(req.query.limit);
            if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
                return res.status(400).json({ error: 'Limit must be between 1 and 200.', code: 'invalid-planning-query' });
            }
            if (req.query.cursor !== undefined && (typeof req.query.cursor !== 'string' || req.query.cursor.length > 4096)) {
                return res.status(400).json({ error: 'Invalid planning cursor.', code: 'invalid-planning-query' });
            }
            res.json(await query(pool, { city, bbox, limit, ...(req.query.source === undefined ? {} : { source: req.query.source }),
                ...(req.query.scenario === undefined ? {} : { scenario: req.query.scenario }),
                ...(req.query.cursor === undefined ? {} : { cursor: req.query.cursor }) }));
        } catch (error) {
            if (error.status === 400) return res.status(400).json({ error: 'Choose a smaller map area.', code: 'invalid-planning-query' });
            console.error('[planning] Source read failed', error);
            res.status(503).json({ error: 'Planning source is unavailable.', code: 'planning-source-unavailable' });
        }
    });
}
