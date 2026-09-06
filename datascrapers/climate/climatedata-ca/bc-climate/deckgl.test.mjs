import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeTile,selectBand,tilesInBounds} from './deckgl.mjs';

test('native rectangles reuse shared edges, preserve values, omit NaN',()=>{
 const grid={id:'g',xEdges:[0,1,2],yEdges:[1,0]};
 const tile={row:0,col:0,width:2,height:1,count:2};
 const product={id:'test',bands:[{units:'days',horizon:'2071-2100',percentile:'p50',measure:'absolute'},{units:'days'}]};
 const bytes=new Uint8Array(new Float64Array([3.141592653589793,7,NaN,8]).buffer);
 const data=decodeTile(grid,tile,[0,1],bytes,product,0);
 assert.equal(data.features[0].properties.value,Math.PI);
 assert.deepEqual(data.features[0].geometry.coordinates[0][1],data.features[1].geometry.coordinates[0][0]);
 assert.equal(data.features[0].id,'g:0:0');
 assert.equal(decodeTile(grid,tile,[0,1],bytes,product,1).features.length,1);
 assert.throws(()=>decodeTile(grid,tile,[0],bytes,product,0),/dimensions/);
});
test('selection rejects ambiguity and distinguishes source deltas',()=>{
 const product={bands:[{measure:'absolute',horizon:'2071-2100'},{measure:'source-delta',horizon:'2071-2100'}]};
 assert.throws(()=>selectBand(product,{horizon:'2071-2100'}),/exactly one/);
 assert.equal(selectBand(product,{measure:'source-delta'}).index,1);
});
test('viewport filter keeps overlapping native blocks',()=>{
 const grid={tiles:[{bounds:[0,0,2,2]},{bounds:[3,3,4,4]}]};
 assert.equal(tilesInBounds(grid,[1,1,2,2]).length,1);
});
