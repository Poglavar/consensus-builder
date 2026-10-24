// Interior settings round-trip explicit off values and cutaways through independent saved views.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const state = require('../../frontend/js/three-view-state.js');
const share = require('../../frontend/js/map-share.js');
const plan = require('../../frontend/js/plan-record.js');
describe('saved interior display state', () => {
    it('reads booleans and basement cutaways without treating missing values as zero', () => {
        expect(state.read('?xray=1&suggested=1&cutaway=-2')).toEqual({ xray:'1', suggested:'1', suggestedExisting:'0', cutaway:'-2' });
        expect(state.read('?xray=yes&cutaway=null')).toEqual(state.defaults);
    });
    it('captures live settings, including explicit off values, instead of the arrival URL', () => {
        const store = state.createStore(state.read('?xray=1&suggested=1&cutaway=2'));
        store.set({ xray:'0', suggested:'0', cutaway:'all' });
        const captured = share.capture({ map: { getCenter:()=>({lat:52,lng:-1}), getZoom:()=>18 }, ThreeViewStateStore:store });
        const url = new URL(share.link('https://app.example.test/?xray=1&cutaway=2',captured));
        expect(state.read(url.search)).toEqual(state.defaults);
    });
    it('retains settings in a named plan and validates malformed cuts/flags', () => {
        const cid = 'bafkrei'+'a'.repeat(52);
        const view = {at:'52,-1,18', mode:'model', settings:state.read('?xray=1&cutaway=0')};
        const record = plan.create('Flight view',[cid],view);
        expect(record.view.settings).toEqual(view.settings);
        expect(plan.validate({...record,view:{...record.view,settings:{cutaway:'999'}}})).toMatch(/cutaway/);
        expect(plan.validate({...record,view:{...record.view,settings:{xray:'yes'}}})).toMatch(/interior/);
    });
    it('publishes only changed normalized state and returns defensive copies', () => {
        const changes=[]; const store=state.createStore({},x=>changes.push(x));
        store.set({xray:'1'}); store.set({xray:'1'});
        const copy=store.get(); copy.xray='0';
        expect(store.get().xray).toBe('1'); expect(changes).toHaveLength(1);
        store.set({xray:'0'}); expect(changes[1].xray).toBe('0');
    });
});
