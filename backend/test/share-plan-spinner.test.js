// Slow plan actions use the shared busy control for their whole promise lifetime.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require=createRequire(import.meta.url),BusyControl=require('../../frontend/js/ui/busy-control.js');
const dialog=readFileSync(new URL('../../frontend/js/plan-dialog.js',import.meta.url),'utf8');
function control(){const classes=new Set(),attrs=new Map();return {classList:{toggle:(k,on)=>on?classes.add(k):classes.delete(k),contains:k=>classes.has(k)},setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),classes,attrs};}
describe('plan action busy state',()=>{
 it('stays busy for the full async operation and restores on success',async()=>{
  const button=control();let finish;const work=BusyControl.track(button,()=>new Promise(resolve=>finish=resolve));
  expect(BusyControl.isBusy(button)).toBe(true);expect(button.attrs.get('aria-busy')).toBe('true');finish('ok');await expect(work).resolves.toBe('ok');
  expect(BusyControl.isBusy(button)).toBe(false);expect(button.classes.has('cb-busy')).toBe(false);expect(button.attrs.has('aria-busy')).toBe(false);
 });
 it('restores the busy state after failure while preserving the rejection',async()=>{
  const button=control();await expect(BusyControl.track(button,async()=>{throw Error('failure');})).rejects.toThrow('failure');
  expect(BusyControl.isBusy(button)).toBe(false);expect(button.attrs.has('aria-busy')).toBe(false);
 });
 it('the plan dialog tracks every slow action through the shared helper',()=>{
  expect(dialog).toContain('win.BusyControl.isBusy(el)');expect(dialog).toContain('await win.BusyControl.track(el, async()=>');
  expect(dialog).toContain('await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  expect(dialog).not.toContain('setSharePlanButtonBusy');
 });
});
