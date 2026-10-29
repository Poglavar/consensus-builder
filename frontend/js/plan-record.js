// A named plan is an immutable selection of published designs and a saved map view, without agreement terms.
// It may also schedule its members: a construction window per design, in months (docs/buildout-timeline.md).
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PlanRecord = api;
})(typeof window !== 'undefined' ? window : null, function () {
    'use strict';
    const SCHEMA = 'plan/v1';
    const MAX_DESIGNS = 1000;
    const MAX_TITLE = 160;
    const MODES = Object.freeze(['2d', 'model', 'photo']);
    const LANGUAGES = Object.freeze(['en', 'hr', 'es', 'sr', 'ar', 'fr', 'pt']);
    const LIMITS = Object.freeze({ latitude: 85.0511, longitude: 180, zoomMin: 3, zoomMax: 22, city: 100, setting: 200 });
    const CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const SETTINGS = ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm',
        'permittedMap', 'zoningAreas', 'planningSource', 'planningScenario'];
    const CAMERA = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
    // A construction window is a start and an end month, both inclusive (YYYY-MM), within the years
    // a plan can reach.
    const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
    const MONTHS = Object.freeze({ first: '2026-01', last: '2966-12' });
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
    const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

    function location(value) {
        const parts = typeof value === 'string' ? value.split(',') : [], at = parts.map(Number);
        return parts.length === 3 && parts.every(part => part.trim()) && at.every(Number.isFinite)
            && Math.abs(at[0]) <= LIMITS.latitude && Math.abs(at[1]) <= LIMITS.longitude
            && at[2] >= LIMITS.zoomMin && at[2] <= LIMITS.zoomMax;
    }
    const ascending = values => Array.isArray(values) && values.every((value, index) => !index || values[index - 1] < value);
    const month = value => typeof value === 'string' && MONTH.test(value) && value >= MONTHS.first && value <= MONTHS.last;
    const constructionWindow = value => keys(value, ['start', 'end']) && month(value.start) && month(value.end) && value.start <= value.end;

    // Structural rules and the two named semantic extensions share the runtime's constants/helpers.
    // Ordinary JSON Schema alone cannot order array members or bound numbers encoded inside a string.
    function jsonSchema() {
        const nullable = value => ({ anyOf: [{ type: 'null' }, value] });
        const boundedText = maxLength => ({ type: 'string', minLength: 1, maxLength, 'x-ugt-utf16-maxLength': maxLength });
        const exactObject = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
        return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Named plan/v1',
            $comment: 'Acceptance also requires ugt-map-location format, x-ugt-ascending, x-ugt-plan-members (schedule keys are designCids members, months within range, start ≤ end) and x-ugt-utf16-maxLength (JavaScript string lengths). These semantic extensions use PlanRecord.semanticRules, the same helpers as PlanRecord.validate. Clients ignoring extensions must not claim full validation.',
            ...exactObject({ schema: { const: SCHEMA },
                title: { ...boundedText(MAX_TITLE), pattern: '^\\S(?:[\\s\\S]*\\S)?(?![\\s\\S])' },
                designCids: { type: 'array', minItems: 1, maxItems: MAX_DESIGNS, uniqueItems: true,
                    items: { type: 'string', pattern: CID.source }, 'x-ugt-ascending': true,
                    description: 'Published design CIDs in strictly ascending lexical order; private artifacts may carry unpublished member content until publication.' },
                view: exactObject({ at: { type: 'string', format: 'ugt-map-location',
                    description: `Comma-separated latitude,longitude,zoom; finite numbers, latitude ±${LIMITS.latitude}, longitude ±${LIMITS.longitude}, zoom ${LIMITS.zoomMin}–${LIMITS.zoomMax}.` },
                    mode: { enum: [...MODES] }, city: nullable(boundedText(LIMITS.city)), language: nullable({ enum: [...LANGUAGES] }),
                    camera: nullable(exactObject({ targetLat: { type: 'number', minimum: -LIMITS.latitude, maximum: LIMITS.latitude },
                        targetLng: { type: 'number', minimum: -LIMITS.longitude, maximum: LIMITS.longitude },
                        headingDeg: { type: 'number' }, pitchRad: { type: 'number', minimum: -Math.PI / 2, maximum: 0 }, range: { type: 'number', minimum: 1 } }, CAMERA)),
                    rotate: { type: 'boolean', description: 'Orbit the saved focal point on arrival until the first user action; reduced motion remains still.' },
                    settings: nullable(exactObject(Object.fromEntries(SETTINGS.map(key => [key, boundedText(LIMITS.setting)]))))
                }, ['at', 'mode']),
                schedule: { type: 'object', minProperties: 1, propertyNames: { pattern: CID.source }, 'x-ugt-plan-members': true,
                    description: `Optional construction window per member design CID: start and end months (YYYY-MM, inclusive, ${MONTHS.first}–${MONTHS.last}, start ≤ end). Members without an entry are unscheduled; omit schedule when no member has a window.`,
                    additionalProperties: exactObject({ start: { type: 'string', pattern: MONTH.source }, end: { type: 'string', pattern: MONTH.source } }, ['start', 'end']) }
            }, ['schema', 'title', 'designCids', 'view']) };
    }

    function validate(content) {
        if (!keys(content, ['schema', 'title', 'designCids', 'view', 'schedule']) || content.schema !== SCHEMA) return 'Invalid named plan.';
        if (!text(content.title, MAX_TITLE) || content.title !== content.title.trim()) return `Enter a plan name of up to ${MAX_TITLE} characters.`;
        const cids = content.designCids;
        if (!Array.isArray(cids) || !cids.length || cids.length > MAX_DESIGNS || cids.some(cid => typeof cid !== 'string' || !CID.test(cid))
            || !ascending(cids)) return 'Choose between 1 and 1000 published designs, sorted without duplicates.';
        const v = content.view;
        if (!keys(v, ['at', 'mode', 'city', 'language', 'camera', 'rotate', 'settings']) || !MODES.includes(v.mode)) return 'Invalid saved map view.';
        if (v.rotate !== undefined && typeof v.rotate !== 'boolean') return 'Invalid saved camera rotation.';
        if (!location(v.at)) return 'Invalid saved map location.';
        if (v.city != null && !text(v.city, LIMITS.city)) return 'Invalid plan city.';
        if (v.language != null && !LANGUAGES.includes(v.language)) return 'Invalid plan language.';
        if (v.camera != null && (!keys(v.camera, CAMERA) || !CAMERA.every(key => Number.isFinite(v.camera[key]))
            || Math.abs(v.camera.targetLat) > LIMITS.latitude || Math.abs(v.camera.targetLng) > LIMITS.longitude
            || v.camera.pitchRad < -Math.PI / 2 || v.camera.pitchRad > 0 || v.camera.range < 1)) return 'Invalid saved camera.';
        if (v.settings != null && (!keys(v.settings, SETTINGS) || Object.values(v.settings).some(value => !text(value, LIMITS.setting)))) return 'Invalid saved display settings.';
        return scheduleError(content.schedule, cids);
    }

    function scheduleError(schedule, cids) {
        if (schedule === undefined) return null;
        if (!object(schedule) || !Object.keys(schedule).length) return 'Omit an empty construction schedule.';
        for (const [cid, window] of Object.entries(schedule)) {
            if (!cids.includes(cid)) return 'A construction window names a design that is not in the plan.';
            if (!constructionWindow(window)) return `Enter a construction start and end month between ${MONTHS.first} and ${MONTHS.last}, the start no later than the end.`;
        }
        return null;
    }

    // schedule: { [designCid]: { start, end } }; windows of designs no longer in the plan are dropped,
    // and an empty schedule is left out so an unscheduled plan keeps its content and CID.
    function create(title, designCids, view, schedule = null) {
        const members = [...new Set(designCids)].sort();
        const windows = Object.entries(schedule || {}).filter(([cid, window]) => members.includes(cid) && window)
            .map(([cid, window]) => [cid, { start: window.start, end: window.end }]);
        const content = { schema: SCHEMA, title: String(title || '').trim(), designCids: members,
            view: { at: view.at, mode: view.mode, city: view.city || null, language: view.language || null,
                camera: view.camera || null, rotate: view.mode !== '2d' && view.rotate === true,
                settings: Object.fromEntries(SETTINGS.filter(key => view.settings?.[key] != null).map(key => [key, view.settings[key]])) },
            ...(windows.length ? { schedule: Object.fromEntries(windows) } : {}) };
        const error = validate(content);
        if (error) throw new Error(error);
        return content;
    }
    return Object.freeze({ SCHEMA, MAX_TITLE, MAX_DESIGNS, MONTHS, validate, create, jsonSchema,
        semanticRules: Object.freeze({ location, ascending, text, month, constructionWindow, scheduleError }) });
});
