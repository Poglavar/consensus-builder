// Run the same pure layout planner (the shared interior-viewer planner) in one worker with its bounded generated-result cache.
const version = self.location.search;
importScripts(...['../vendor/turf-6.5.0/turf.min.js', 'building-floor-plans.js', '../vendor/interior-viewer/interior-planner.js'].map(path => path + version));
const cache = new Map();
self.onmessage = ({ data: { id, feature, context } }) => {
    try {
        const result = self.__defaultFloorPlanContext.planBuilding(feature,
            { ...context, cache, turf: self.turf, generator: self.__defaultFloorPlans });
        self.postMessage({ id, result });
    } catch (error) {
        self.postMessage({ id, error: { name: error.name, message: error.message } });
    }
};
