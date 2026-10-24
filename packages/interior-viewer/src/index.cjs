// Shared interior rendering, walking and lifecycle support.
'use strict';
const geometry = require('./geometry.cjs');
const meshes = require('./meshes.cjs');
const navigation = require('./navigation.cjs');
const walking = require('./walking.cjs');
const people = require('./people.cjs');
const presentation = require('./presentation.cjs');
const look = require('./scene.cjs');

// Accept an architectural record or a caller's plan envelope; never fetch or infer geometry.
function normalizeArchitecture(value) {
    const architecture = value?.architecture || value;
    const errors = geometry.validateArchitecture(architecture);
    if (errors.length) throw new TypeError(errors.join('; '));
    return architecture;
}
function applyPlacement(THREE, root, placement) {
    if (!placement) return;
    if (placement.matrix) {
        const matrix = placement.matrix.isMatrix4 ? placement.matrix : new THREE.Matrix4().fromArray(placement.matrix);
        if (!matrix.elements.every(Number.isFinite) || Math.abs(matrix.determinant()) < 1e-12) throw new TypeError('Placement matrix must be finite and invertible');
        root.matrix.copy(matrix); root.matrixAutoUpdate = false;
    } else {
        for (const key of ['position','quaternion','scale']) if (placement[key]) {
            const values=placement[key];
            if (!Array.isArray(values) || values.length !== (key==='quaternion'?4:3) || !values.every(Number.isFinite)) throw new TypeError(`Invalid placement ${key}`);
            root[key].fromArray(values);
        }
        if (root.scale.x===0 || root.scale.y===0 || root.scale.z===0 || root.quaternion.lengthSq()<1e-12) throw new TypeError('Placement must be invertible');
        root.quaternion.normalize();root.updateMatrix();
    }
}
function attach(options) {
    const {THREE, scene, camera, renderer, controls, host, animate, render=()=>{}}=options;
    if (!THREE?.Group || !scene?.add) throw new TypeError('THREE and a host scene are required');
    const architecture=normalizeArchitecture(options.architecture);
    if (options.walking && (!camera || !renderer || !controls || !host || !animate)) throw new TypeError('Walking requires camera, renderer, controls, host and host animate hook');
    const root=new THREE.Group();root.name='InteriorViewer';
    applyPlacement(THREE,root,options.placement);
    const group=meshes.createLocalUnitGroup(THREE,architecture,geometry,{colors:options.colors});root.add(group);
    let disposed=false,removePeople=null;
    const context={THREE,scene,root,group,camera,renderer,controls,host,architecture,animate,render,
        quality:options.quality,labels:options.labels,stopAutoRotate:options.stopAutoRotate};
    scene.add(root);
    try { if(options.walking) removePeople=people.mount(context,options.env||globalThis); }
    catch(error) { scene.remove(root);meshes.disposeGroup(group);throw error; }
    render();
    return Object.assign(context,{
        navigation:removePeople?.navigation || null,
        walkers:removePeople?.walkers || [],
        personView:removePeople?.personView || null,
        dispose(){if(disposed)return;disposed=true;removePeople?.();root.remove(group);meshes.disposeGroup(group);root.removeFromParent();render();}
    });
}
module.exports={version:'1.0.0',geometry,meshes,navigation,walking,personView:walking,people,presentation,look,normalizeArchitecture,attach,
    mountStandalone:(host,architecture,options)=>require('./standalone.cjs').mountStandalone(host,architecture,options)};
