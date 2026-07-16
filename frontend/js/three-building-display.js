// Defines the Built/Planned display-state model independently from Three.js rendering and controls.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeBuildingDisplay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const BUILT_STATES = Object.freeze(['solid', 'ghost', 'surviving', 'removed', 'off']);
    const PLANNED_STATES = Object.freeze(['solid', 'ghost', 'off']);

    function displayStatesForKind(kind) {
        if (kind === 'built') return [...BUILT_STATES];
        if (kind === 'planned') return [...PLANNED_STATES];
        return [];
    }

    function resolveBuiltDisplayPolicy(state) {
        switch (state) {
            case 'ghost':
                return {
                    visible: true,
                    material: 'ghost',
                    showSurviving: true,
                    showDemolished: true,
                    showExistingRail: true
                };
            case 'surviving':
                return {
                    visible: true,
                    material: 'solid',
                    showSurviving: true,
                    showDemolished: false,
                    showExistingRail: true
                };
            case 'removed':
                return {
                    visible: true,
                    material: 'solid',
                    showSurviving: false,
                    showDemolished: true,
                    showExistingRail: false
                };
            case 'off':
                return {
                    visible: false,
                    material: 'solid',
                    showSurviving: false,
                    showDemolished: false,
                    showExistingRail: false
                };
            case 'solid':
            default:
                return {
                    visible: true,
                    material: 'solid',
                    showSurviving: true,
                    showDemolished: true,
                    showExistingRail: true
                };
        }
    }

    function resolveBuildingRenderParts(carve, visibility = {}) {
        const showSurviving = visibility.showSurviving !== false;
        const showDemolished = visibility.showDemolished !== false;
        if (!carve) {
            return { detailed: showSurviving, remainder: false, demolished: false };
        }
        if (carve.remainder) {
            return { detailed: false, remainder: showSurviving, demolished: showDemolished };
        }
        return { detailed: showDemolished, remainder: false, demolished: false };
    }

    return { displayStatesForKind, resolveBuiltDisplayPolicy, resolveBuildingRenderParts };
});
