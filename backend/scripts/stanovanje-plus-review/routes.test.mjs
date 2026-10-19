import {test} from 'node:test';
import assert from 'node:assert/strict';
import {reviewRoutes} from './routes.mjs';
test('review routes expose only source images, selected revisions and shared rendering modules',()=>{
 const routes=reviewRoutes('/private-review','/repository',[
  {source:{code:'first'},revision:'original'}, {source:{code:'second'},revision:'refined'}
 ]);
 assert.equal(routes.get('/model/first/model.json'),'/private-review/first/model.json');
 assert.equal(routes.get('/model/second/model.refined.json'),'/private-review/second/model.refined.json');
 assert.equal(routes.get('/model/first/model.refined.json'),'/private-review/first/model.refined.json');
 assert.equal(routes.get('/model/second/model.json'),'/private-review/second/model.json');
 assert.equal(routes.get('/shared/three-floor-plans.js'),'/repository/frontend/js/three-floor-plans.js');
 for(const blocked of ['/source/first/response.json','/source/first/source.svg','/.env','/../package.json','/shared/../index.html'])assert.equal(routes.has(blocked),false,blocked);
 assert.equal(routes.get('/source/first/source.png'),'/private-review/first/source.png');
});
test('source identifiers cannot escape the source directory',()=>{
 assert.throws(()=>reviewRoutes('/private-review','/repository',[{source:{code:'../outside'},revision:'original'}]),/Invalid source code/);
});
