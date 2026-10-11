import test from 'node:test';
import assert from 'node:assert/strict';
import {probeLocations,safeDescriptor,safeSample} from '../probe-parcel-provider.mjs';
test('UN latitude longitude becomes bounded source longitude latitude without moving original center',()=>{
 const locations=probeLocations([50,14]); assert.equal(locations.length,9); assert.deepEqual(locations[0].point,[14,50]);
 assert.deepEqual(locations[0].bbox,[13.99975,49.99975,14.00025,50.00025]);
 assert.throws(()=>probeLocations([null,14])); assert.throws(()=>probeLocations([91,14]));
});
test('safe request keeps parcel IDs and fixed source predicates but removes attribute payload',()=>{
 const d={adapter:'arcgis',idField:'OID',outFields:['OID','OWNER'],parcelNumberField:'LABEL',attributeFilters:{STATUS:'current'}};
 const safe=safeDescriptor(d); assert.deepEqual(safe.outFields,['OID','STATUS']); assert.equal(safe.parcelNumberField,undefined);
 assert.equal(d.parcelNumberField,'LABEL'); assert.throws(()=>safeDescriptor({...d,idField:'owner_id'}));
});
test('WFS requires mapped geometry field and only safe properties',()=>{
 assert.throws(()=>safeDescriptor({adapter:'wfs',idField:'КН',outFields:['КН']}));
 const safe=safeDescriptor({adapter:'wfs',idField:'КН',geometryField:'geom',outFields:['КН']});
 assert.equal(safe.requestProperties,true);
});
test('sample preserves full geometry while retaining native identity only',()=>{
 const geometry={type:'Polygon',coordinates:[[[1,2],[2,2],[2,3],[1,2]]]};
 const f={type:'Feature',properties:{sourceId:'s',sourceParcelId:'007',parcelId:'P-007',other:'private'},geometry};
 assert.deepEqual(safeSample(f,'s'),{type:'Feature',properties:{id:'007'},geometry});
 assert.equal(safeSample(f,'s').geometry,geometry); assert.throws(()=>safeSample(f,'foreign'));
});

test('namespace and cadastral tile identities survive the safe property projection',()=>{
 const namespace=safeDescriptor({adapter:'ogc-api',idField:'local_id',idNamespace:{field:'namespace',value:'verified'},outFields:['local_id','namespace','OWNER']});
 assert.deepEqual(namespace.outFields,['local_id','namespace']);
 assert.deepEqual(safeDescriptor({adapter:'bev-tiles',outFields:['kg','gnr','ez','rstatus']}).outFields,['kg','gnr','rstatus']);
});
