import { openPlanActions } from '../helpers/plan-actions';
import { test, expect } from '../helpers/fixtures';
import { applyLayout } from '../helpers/agreements';
import { openCity, createSpace, showProposal, stubBasemapTiles } from '../helpers/runtime';

test.beforeEach(async ({ mockApi: page }) => { await stubBasemapTiles(page); });

test('the rooster touches each inspected parcel with its beak and highlights only that parcel', async ({ mockApi: page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { layoutId } = await applyLayout(page); await showProposal(page, layoutId);
  await page.evaluate(() => {
    const w:any=window, original=Element.prototype.animate; w.__pecks=0;
    Element.prototype.animate=function(frames:any,options:any){const animation=original.call(this,frames,options);if(this.matches('.grain-rooster__body')&&frames[1]?.transform?.includes('rotate(-35deg)')){animation.pause();animation.currentTime=options.duration*frames[1].offset;w.__pecks++;let release:any;const finished=new Promise(resolve=>release=resolve);w.__releasePeck=()=>{animation.cancel();release();};return{finished,cancel:()=>animation.cancel()}as any;}return animation;};
  });
  await page.locator('#proposals-button').click(); await (await openPlanActions(page)).getByRole('button', { name: 'Urban rooster', exact: true }).click();
  for(let index=1;index<=2;index++){await expect.poll(()=>page.evaluate(()=>(window as any).__pecks)).toBe(index);const sample=await page.evaluate(()=>{const w:any=window,active=document.querySelector('.grain-score-parcel.is-active')as SVGPathElement,beak=document.querySelector('[data-grain-role="beak"]')as SVGPathElement;const contact=new DOMPoint(28,79).matrixTransform(beak.getScreenCTM()!);return{active:document.querySelectorAll('.grain-score-parcel.is-active').length,inside:active.isPointInFill(contact.matrixTransform(active.getScreenCTM()!.inverse())),selectedProposal:w.currentlyHighlightedProposalId};});expect(sample).toEqual({active:1,inside:true,selectedProposal:null});await page.evaluate(()=>(window as any).__releasePeck());}
  await expect(page.locator('#grain-score-panel [data-grain-role="result"]')).toBeVisible({timeout:15000});
});

test('composing a plan selects membership independently of map focus', async ({ mockApi: page }) => {
  await openCity(page); const first=await createSpace(page,'park');
  await page.evaluate(id=>(window as any).ProposalManager.unapplyProposal(id),first);
  await createSpace(page,'square');
  const center=await page.evaluate(()=>{const c=(window as any).map.getCenter();return[c.lat,c.lng];});
  await page.locator('#proposals-button').click(); await page.locator('#shareAppliedProposalsButton').click();
  await page.locator('#lists-actions').getByRole('button',{name:'Create plan',exact:true}).click();
  const form=page.locator('.plan-composer');const choices=form.locator('input[type=checkbox]');
  await expect(choices).toHaveCount(2);await choices.first().check();await choices.nth(1).uncheck();
  expect(await page.evaluate(()=>{const c=(window as any).map.getCenter();return[c.lat,c.lng];})).toEqual(center);
  await expect(form.locator('.plan-dialog__count')).toHaveText('1 selected');
});
