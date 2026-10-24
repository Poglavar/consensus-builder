// Shared interior rendering, walking and lifecycle support.
'use strict';
const path=require('node:path');
const {createRequire}=require('node:module');
const {build}=createRequire(path.resolve(__dirname,'../../backend/package.json'))('esbuild');
const output=path.resolve(__dirname,'../../frontend/vendor/interior-viewer');
function settings(entry,name,file){return {
    entryPoints:[path.join(__dirname,'src',entry)],bundle:true,format:'iife',globalName:name,platform:'browser',target:'es2020',
    outfile:path.join(output,file),
    banner:{js:`/* ${name} 1.0.0 — generated from packages/interior-viewer; do not edit. */`},
    footer:{js:`if (typeof module === "object" && module.exports) module.exports = ${name};`},legalComments:'inline'
};}
// The mesh-only artifact consumes the geometry artifact already loaded by the host. The full
// standalone artifact remains self-contained; both builds use the same maintained mesh source.
const mesh=settings('meshes.cjs','InteriorMeshes','interior-meshes.js');
mesh.banner.js+='\nvar InteriorGeometryDependency = typeof module === "object" && module.exports ? require("./interior-geometry.js") : globalThis.InteriorGeometry;';
mesh.plugins=[{name:'shared-interior-geometry',setup(builder){
    builder.onResolve({filter:/^\.\/geometry\.cjs$/},()=>({path:'geometry',namespace:'shared-interior'}));
    builder.onLoad({filter:/.*/,namespace:'shared-interior'},()=>({contents:'module.exports = InteriorGeometryDependency;',loader:'js'}));
}}];
Promise.all([
    build(settings('geometry.cjs','InteriorGeometry','interior-geometry.js')),
    build(mesh),
    build(settings('index.cjs','InteriorViewer','interior-viewer.js'))
]).catch(error=>{console.error(error.message);process.exitCode=1;});
