// Shared interior rendering, walking and lifecycle support.
'use strict';
const geometry=require('./geometry.cjs');
// Optional model-local drafting edges and a ceiling. No scene lighting or renderer mutation.
function mount({THREE,group,architecture,render=()=>{}},{colors={},edgeColor=0x46545e,personView=()=>false}={}) {
    const edges=[],ceiling=new THREE.Group();ceiling.name='ApartmentVisibleCeiling';
    const roofMaterial=new THREE.MeshStandardMaterial({color:colors.wall||0xf2eee5,side:THREE.DoubleSide,roughness:.95});
    group.traverse(mesh=>{if(!mesh.name?.startsWith('UnitPart:')||mesh.name==='UnitPart:glass')return;
        const line=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry,35),new THREE.LineBasicMaterial({color:edgeColor,transparent:true,opacity:.22}));
        mesh.add(line);edges.push(line);
    });
    for(const part of geometry.buildLocalUnitParts(architecture).filter(part=>part.kind==='slab')) {
        const shape=new THREE.Shape(part.rings[0].map(p=>new THREE.Vector2(...p)));
        part.rings.slice(1).forEach(ring=>shape.holes.push(new THREE.Path(ring.map(p=>new THREE.Vector2(...p)))));
        const buffer=new THREE.ExtrudeGeometry(shape,{depth:architecture.slabThicknessM,bevelEnabled:false});buffer.translate(0,0,architecture.wallHeightM);
        ceiling.add(new THREE.Mesh(buffer,roofMaterial));
    }
    group.add(ceiling);let disposed=false;
    function update(){const active=Boolean(personView());ceiling.visible=active;edges.forEach(edge=>{edge.visible=!active;});}
    update();render();
    return {update,dispose(){if(disposed)return;disposed=true;ceiling.removeFromParent();ceiling.children.forEach(mesh=>mesh.geometry.dispose());roofMaterial.dispose();edges.forEach(edge=>{edge.removeFromParent();edge.geometry.dispose();edge.material.dispose();});}};
}
module.exports={mount};
