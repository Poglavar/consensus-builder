// The browser's height surveys (buildings/height-survey.js): data/height-surveys.json read once at
// load, one measurer for the session (so a building is measured once), and the two uses the app has:
// filling the heights a relative rule term needs, and measuring the building a card shows.
(function (root) {
    'use strict';
    const log = message => console.warn(`[${new Date().toISOString()}] [height-survey] ${message}`);
    let surveys = null, measurer = null;
    const loading = fetch('data/height-surveys.json', { cache: 'no-cache' })
        .then(response => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); })
        .then(config => { surveys = config.surveys || []; return surveys; })
        .catch(error => { console.error(`[${new Date().toISOString()}] [height-survey] data/height-surveys.json could not be read; no heights are measured`, error); surveys = []; return surveys; });
    async function instance() {
        await loading;
        measurer ??= root.HeightSurvey.createMeasurer({ surveys, proj4: root.proj4, log });
        return measurer;
    }
    const firstPoint = geometry => (geometry?.type === 'Polygon' ? geometry.coordinates[0]?.[0] : geometry?.type === 'MultiPolygon' ? geometry.coordinates[0]?.[0]?.[0] : null);
    // The survey covering a building, or null (also while the configuration is still loading).
    function surveyFor(feature) {
        const point = firstPoint(feature?.geometry);
        return point && surveys ? root.HeightSurvey.surveyAt(surveys, point) : null;
    }
    const known = record => root.PlanningRuleTerms.buildingHeight(record).known;
    // Records (map building features) with measured heights where theirs are unknown.
    async function fillHeights(records, { idOf, signal } = {}) {
        return root.HeightSurvey.fillMissingHeights(await instance(), records, { known, idOf, signal });
    }
    // One building's result ({ heightM, ... } or { rejection }).
    async function measureOne(feature, id) {
        const results = await (await instance()).measure([{ id: String(id), geometry: feature.geometry }]);
        return results.get(String(id));
    }
    root.HeightSurveyClient = { surveyFor, fillHeights, measureOne, known, ready: loading };
})(window);
