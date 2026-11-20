import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {activeTotal} from './out/payments.js';
import {normalizedTitle} from './out/title.js';
import {SaveButton} from './out/button.js';
import {uniqueIds} from './out/distinct.js';
import {getLesson} from './out/lesson.js';
import {effectiveCost} from './out/cost.js';
const results={};
function task(name,fn){try{fn();results[name]=true;}catch{results[name]=false;}}
task('payments',()=>{const rows=Object.freeze([Object.freeze({amount:3,voidedAt:null}),Object.freeze({amount:-2,voidedAt:null}),Object.freeze({amount:999,voidedAt:'void'}),Object.freeze({amount:0,voidedAt:null})]);assert.equal(activeTotal(rows),1);assert.equal(activeTotal([]),0);assert.throws(()=>activeTotal([{amount:.5,voidedAt:null}]),RangeError);assert.throws(()=>activeTotal([{amount:Number.MAX_SAFE_INTEGER,voidedAt:null},{amount:1,voidedAt:null}]),RangeError);assert.equal(activeTotal([{amount:Infinity,voidedAt:'void'}]),0);});
task('title',()=>{assert.equal(normalizedTitle(null),'');assert.equal(normalizedTitle('  a  b  '),'a  b');assert.equal(normalizedTitle('\n\t'),'');});
task('button',()=>{for(const busy of [false,true])for(const valid of [false,true]){let called=0;const element=SaveButton({busy,valid,onSave:()=>called++});assert.equal(element.type,'button');assert.equal(element.props.type,'button');assert.equal(element.props.disabled,busy||!valid);assert.equal(element.props.children,'Save');if(!busy&&valid){element.props.onClick();assert.equal(called,1);}const html=renderToStaticMarkup(element);assert.equal(html.includes('disabled=""'),busy||!valid);}});
task('distinct',()=>{const ids=Object.freeze(['b','a','b','','a']);assert.deepEqual(uniqueIds(ids),['b','a','']);assert.deepEqual(uniqueIds([]),[]);});
task('lesson',()=>{const rows=Object.freeze([Object.freeze({id:'1',ownerId:'a',topic:'one'}),Object.freeze({id:'2',ownerId:'b',topic:'secret'})]);assert.deepEqual(getLesson(null,'2',rows),{status:401,body:{error:'UNAUTHORIZED'}});for(const id of ['2','missing'])assert.deepEqual(getLesson('a',id,rows),{status:404,body:{error:'NOT_FOUND'}});assert.deepEqual(getLesson('a','1',rows),{status:200,body:{id:'1',topic:'one'}});});
task('cost',()=>{const a={execution:2,retry:1,review:3,fix:2,context:2};const b={execution:1,retry:0,review:1,fix:0,context:0};assert.equal(effectiveCost([a,b],1),12);assert.equal(effectiveCost([a,b],2),6);assert.equal(effectiveCost([],0),null);for(const accepted of [-1,.5,3,NaN,Infinity])assert.throws(()=>effectiveCost([a,b],accepted),RangeError);for(const value of [-1,NaN,Infinity])assert.throws(()=>effectiveCost([{...a,review:value}],0),RangeError);});
console.log(JSON.stringify(results));
