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
    const CID = /^baf(?:krei[a-z2-7]{52}|ybei[a-z2-7]{52})$/;
    const SETTINGS = ['existing', 'permitted', 'proposed', 'existingScope', 'proposedForm', 'permittedForm',
        'permittedMap', 'zoningAreas', 'planningSource', 'planningScenario', 'xray', 'suggested', 'suggestedExisting', 'cutaway'];
    const CAMERA = ['targetLat', 'targetLng', 'headingDeg', 'pitchRad', 'range'];
    const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
    const keys = (value, allowed) => object(value) && Object.keys(value).every(key => allowed.includes(key));
    const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;

    function validate(content) {
        if (!keys(content, ['schema', 'title', 'designCids', 'view']) || content.schema !== SCHEMA) return 'Invalid named plan.';
        if (!text(content.title, MAX_TITLE) || content.title !== content.title.trim()) return `Enter a plan name of up to ${MAX_TITLE} characters.`;
        const cids = content.designCids;
        if (!Array.isArray(cids) || !cids.length || cids.length > MAX_DESIGNS || cids.some(cid => typeof cid !== 'string' || !CID.test(cid))
            || cids.some((cid, index) => index && cids[index - 1] >= cid)) return 'Choose between 1 and 1000 published designs, sorted without duplicates.';
        const v = content.view;
        if (!keys(v, ['at', 'mode', 'city', 'language', 'camera', 'settings']) || !['2d', 'model', 'photo'].includes(v.mode)) return 'Invalid saved map view.';
        const at = typeof v.at === 'string' ? v.at.split(',').map(Number) : [];
        if (at.length !== 3 || v.at.split(',').some(part => !part.trim()) || !at.every(Number.isFinite)
            || Math.abs(at[0]) > 85.0511 || Math.abs(at[1]) > 180 || at[2] < 3 || at[2] > 22) return 'Invalid saved map location.';
        if (v.city != null && !text(v.city, 100)) return 'Invalid plan city.';
        if (v.language != null && !['en', 'hr', 'es', 'sr'].includes(v.language)) return 'Invalid plan language.';
        if (v.camera != null && (!keys(v.camera, CAMERA) || !CAMERA.every(key => Number.isFinite(v.camera[key]))
            || Math.abs(v.camera.targetLat) > 85.0511 || Math.abs(v.camera.targetLng) > 180
            || v.camera.pitchRad < -Math.PI / 2 || v.camera.pitchRad > 0 || v.camera.range < 1)) return 'Invalid saved camera.';
        if (v.settings != null && (!keys(v.settings, SETTINGS) || Object.values(v.settings).some(value => !text(value, 200)))) return 'Invalid saved display settings.';
        for (const key of ['xray', 'suggested', 'suggestedExisting']) {
            if (v.settings?.[key] != null && !['0', '1'].includes(v.settings[key])) return 'Invalid saved interior display.';
        }
        const cut = v.settings?.cutaway;
        if (cut != null && cut !== 'all' && (!/^-?\d+$/.test(cut) || Math.abs(Number(cut)) > 100)) return 'Invalid saved floor cutaway.';
        return null;
    }

    function create(title, designCids, view) {
        const content = { schema: SCHEMA, title: String(title || '').trim(), designCids: [...new Set(designCids)].sort(),
            view: { at: view.at, mode: view.mode, city: view.city || null, language: view.language || null,
                camera: view.camera || null, settings: Object.fromEntries(SETTINGS.filter(key => view.settings?.[key] != null).map(key => [key, view.settings[key]])) } };
        const error = validate(content);
        if (error) throw new Error(error);
        return content;
    }
    return Object.freeze({ SCHEMA, MAX_TITLE, MAX_DESIGNS, validate, create });
});
