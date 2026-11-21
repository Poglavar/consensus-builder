// Run the same pure layout planner in one worker with its bounded generated-result cache.
const version = self.location.search;
importScripts(...['../vendor/turf-6.5.0/turf.min.js', 'geometry-tolerances.js', 'building-use.js', 'building-floor-plans.js',
    'default-floor-plan-rooms.js', 'default-floor-plans.js', 'default-floor-plan-core.js',
    'default-floor-plan-context.js'].map(path => path + version));
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
