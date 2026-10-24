// The model scene uses the canonical shared interior mesh module.
(function(root){
    const api = root ? root.InteriorMeshes : require('../vendor/interior-viewer/interior-meshes.js');
    if (!api) throw new Error('Shared interior module is unavailable.');
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeFloorPlans = api;
})(typeof window !== 'undefined' ? window : null);
