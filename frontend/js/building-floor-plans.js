// Architectural records use the canonical shared geometry module.
(function(root){
    const api = root ? root.InteriorGeometry : require('../vendor/interior-viewer/interior-geometry.js');
    if (!api) throw new Error('Shared interior module is unavailable.');
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__buildingFloorPlans = api;
})(typeof window !== 'undefined' ? window : null);
