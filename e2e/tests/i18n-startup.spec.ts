import { test, expect } from '../helpers/fixtures';

test('slow selected locale never reveals translation keys or English labels before Spanish',async({mockApi:page})=>{
 let release!:()=>void;
 const held=new Promise<void>(resolve=>release=resolve);
 const requests:string[]=[];
 await page.route('**/i18n/*.json*',async route=>{
  const lang=new URL(route.request().url()).pathname.split('/').pop()!;
  requests.push(lang);
  if(lang==='es.json') await held;
  await route.continue();
 });
 await page.goto('/?city=new_york&lang=es&reduceMotion=1',{waitUntil:'domcontentloaded'});
 const label=page.locator('#proposals-button .map-shell-button-label');
 await expect(label).toHaveText('Lists');
 await expect(label).toBeHidden();
 expect(requests).not.toContain('hr.json');
 expect(requests).not.toContain('sr.json');
 release();
 await expect(label).toBeVisible();
 await expect(label).toHaveText('Listas');
 await expect(page.locator('body')).not.toHaveClass(/i18n-loading/);
});

test('failed selected locale uses readable English instead of translation keys',async({mockApi:page})=>{
 await page.route('**/i18n/es.json*',route=>route.fulfill({status:503,body:'Unavailable'}));
 await page.goto('/?city=new_york&lang=es&reduceMotion=1');
 const label=page.locator('#proposals-button .map-shell-button-label');
 await expect(label).toBeVisible();
 await expect(label).toHaveText('Lists');
 await expect(label).not.toContainText('lists.');
});
