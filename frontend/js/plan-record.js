// A named plan is an immutable selection of published designs and a saved map view, without agreement terms.
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
    const LANGUAGES = Object.freeze(['en', 'hr', 'es', 'sr']);
    const LIMITS = Object.freeze({ latitude: 85.0511, longitude: 180, zoomMin: 3, zoomMax: 22, city: 100, setting: 200 });
    const CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const SETTINGS = ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm',
        'permittedMap', 'zoningAreas', 'planningSource', 'planningScenario'];
    const CAMERA = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
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

    // Structural rules and the two named semantic extensions share the runtime's constants/helpers.
    // Ordinary JSON Schema alone cannot order array members or bound numbers encoded inside a string.
    function jsonSchema() {
        const nullable = value => ({ anyOf: [{ type: 'null' }, value] });
        const boundedText = maxLength => ({ type: 'string', minLength: 1, maxLength, 'x-ugt-utf16-maxLength': maxLength });
        const exactObject = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
        return { $schema: 'https://json-schema.org/draft/2020-12/schema', title: 'Named plan/v1',
            $comment: 'Acceptance also requires ugt-map-location format, x-ugt-ascending and x-ugt-utf16-maxLength (JavaScript string lengths). These semantic extensions use PlanRecord.semanticRules, the same helpers as PlanRecord.validate. Clients ignoring extensions must not claim full validation.',
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
                }, ['at', 'mode'])
            }, ['schema', 'title', 'designCids', 'view']) };
    }

    function validate(content) {
        if (!keys(content, ['schema', 'title', 'designCids', 'view']) || content.schema !== SCHEMA) return 'Invalid named plan.';
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
        return null;
    }

    function create(title, designCids, view) {
        const content = { schema: SCHEMA, title: String(title || '').trim(), designCids: [...new Set(designCids)].sort(),
            view: { at: view.at, mode: view.mode, city: view.city || null, language: view.language || null,
                camera: view.camera || null, rotate: view.mode !== '2d' && view.rotate === true,
                settings: Object.fromEntries(SETTINGS.filter(key => view.settings?.[key] != null).map(key => [key, view.settings[key]])) } };
        const error = validate(content);
        if (error) throw new Error(error);
        return content;
    }
    return Object.freeze({ SCHEMA, MAX_TITLE, MAX_DESIGNS, validate, create, jsonSchema,
        semanticRules: Object.freeze({ location, ascending, text }) });
});
