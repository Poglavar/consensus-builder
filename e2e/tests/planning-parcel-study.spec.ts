// Synthetic source responses exercise actual study controls, persistence and stale-reference handling.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.use({ seedCity: 'colorado' });
const geometry = { type: 'Polygon', coordinates: [[[-104.9907,39.7391],[-104.9902,39.7391],[-104.9902,39.7395],[-104.9907,39.7395],[-104.9907,39.7391]]] };
const source = { id: 'atlas-study-test', city: 'colorado', label: 'Synthetic Atlas study', edition: 'test',
  url: 'https://example.test/source', recordId: 'slice-test', version: 'source-1', scenario: 'family1', scenarios: ['family1'],
  default: true, capabilities: { areas: true, volumes: false }, parcelStudy: 'direct-dimensions.v1', parcelSourceId: 'parcel-test' };
function context(revision = 'source-1') {
  return { schemaVersion: 'planning-parcel-study.v1',
    source: { id: 'atlas-study-test:slice-test', source: { ...source, version: revision }, site: geometry, role: 'permitted',
      constraints: [['frontSetback',20,'estimated'],['sideSetback',5,'direct'],['rearSetback',10,'direct'],['height',35,'direct']]
        .map(([quantity,value,evidence]) => ({ quantity,value,evidence,unit:'ft' })).concat([{ quantity:'lotArea',value:0.1,evidence:'direct',unit:'acres' }]),
      assessment: { status: 'allowed' }, sourceEvidence: { numericEvidence: { family1_maxlotcoverage_building: { status:'direct',value:50 } } } },
    sourceReference: { proposalId:'source:atlas-study-test:slice-test',providerId:source.id,recordId:'slice-test',edition:'test',revision,city:'colorado',parcelId:null,scenario:'family1' },
    parcel: { type:'Feature',id:'parcel-test',geometry,properties:{parcelNumber:'Synthetic parcel'} },
    parcelReference:{sourceId:'parcel-test',parcelId:'parcel-test',revision:'parcel-1'},
    parcelSource:{id:'parcel-test',label:'Synthetic parcel source',url:'https://example.test/parcel'},
    coveredGeometry:geometry,sourceCoverage:{uncoveredM2:0,parcelAreaM2:1800} };
}
const url = '/?at=39.73930,-104.99045,19&planningSource=atlas-study-test&planningScenario=family1&planningParcel=parcel-test&permitted=ghost&reduceMotion=1';

test('Atlas parcel study edits actual geometry, rechecks limits and survives reload @features', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  await page.route('**/planning/**', async route => {
    if (!['xhr','fetch'].includes(route.request().resourceType())) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith('/study') ? context() : path.endsWith('/sources') ? {city:'colorado',sources:[source]}
      : { schemaVersion:'planning-representations.v1',city:'colorado',items:[],sources:[source],summaries:[],unavailable:[],coverage:'source-results',nextCursor:null,omitted:0 };
    await route.fulfill({json});
  });
  await page.goto(url); await waitForMapReady(page);
  const inspector = page.locator('#planning-inspector');
  await expect(inspector.getByLabel('Design height (m)')).toBeVisible({ timeout:45_000 });
  await expect(inspector.locator('[data-check="height"]')).toHaveAttribute('data-status','pass');
  await expect(inspector.locator('[data-check="frontSetback"]')).toHaveAttribute('data-status','unknown');
  const original = await page.evaluate(() => (window as any).PlanningViews.getItems().find((item:any) => item.assessment.meaning === 'study-design').site);
  await inspector.getByLabel('Design height (m)').fill('12');
  await expect(inspector.locator('[data-check="height"]')).toHaveAttribute('data-status','fail');
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().find((item:any) => item.assessment.meaning === 'study-design').volumes[0].topM)).toBe(12);
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().find((item:any) => item.assessment.meaning === 'study-design').site)).toEqual(original);
  await page.reload(); await waitForMapReady(page);
  await expect(inspector.getByLabel('Design height (m)')).toHaveValue('12', {timeout:45_000});
  await expect(inspector.locator('[data-check="height"]')).toHaveAttribute('data-status','fail');
  await inspector.getByLabel('Design height (m)').fill('9');
  await expect(inspector.locator('[data-check="height"]')).toHaveAttribute('data-status','pass');
  await inspector.getByLabel('Move east (m)').fill('50');
  await expect(inspector.locator('[data-check="parcelContainment"]')).toHaveAttribute('data-status','fail');
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().filter((item:any) => item.study).length)).toBe(2);
  await inspector.getByRole('button',{name:'Reset test design'}).click();
  await expect(inspector.locator('[data-study-summary]')).toHaveAttribute('data-study-summary','unresolved');
  await inspector.getByLabel('Move east (m)').fill('');
  await inspector.getByLabel('Design height (m)').fill('12');
  await inspector.locator('select[data-study-input="frontEdge"]').selectOption('1');
  await expect(inspector.locator('[data-study-summary]')).toHaveCount(0);
  await expect(inspector.getByLabel('Move east (m)')).toHaveAttribute('aria-invalid','true');
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().find((item:any) => item.assessment.meaning === 'study-design').volumes[0].topM)).toBe(9);
  await inspector.getByLabel('Move east (m)').fill('0');
  await expect(inspector.locator('[data-check="height"]')).toHaveAttribute('data-status','fail');
  expect(await page.evaluate(() => (window as any).PlanningParcelStudy.getForm().frontEdge)).toBe(1);
  await page.setViewportSize({width:390,height:844});
  const bounds = await inspector.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(390);
});

test('changed Atlas input requires an explicit new study and retains the old draft @features', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  let revision = 'source-1';
  await page.route('**/planning/**', async route => {
    if (!['xhr','fetch'].includes(route.request().resourceType())) return route.fallback();
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({json:path.endsWith('/study') ? context(revision) : path.endsWith('/sources') ? {city:'colorado',sources:[source]}
      : {schemaVersion:'planning-representations.v1',city:'colorado',items:[],sources:[source],summaries:[],unavailable:[],coverage:'source-results',nextCursor:null,omitted:0}});
  });
  await page.goto(url); await waitForMapReady(page);
  const inspector = page.locator('#planning-inspector');
  await expect(inspector.getByLabel('Design height (m)')).toBeVisible({timeout:45_000});
  await inspector.getByLabel('Design height (m)').fill('12');
  revision = 'source-2';
  await page.reload(); await waitForMapReady(page);
  await expect(inspector.getByText('The parcel or zoning source has changed.',{exact:false})).toBeVisible({timeout:45_000});
  expect(await page.evaluate(() => JSON.parse((window as any).PersistentStorage.getItem('cb_planning_parcel_study_v1')).design.topM)).toBe(12);
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().filter((item:any) => item.study).flatMap((item:any)=>item.volumes).length)).toBe(0);
  await inspector.getByRole('button',{name:'Start again with current sources'}).click();
  await expect(inspector.getByLabel('Design height (m)')).toHaveValue('9');
  expect(await page.evaluate(() => JSON.parse((window as any).PersistentStorage.getItem('cb_planning_parcel_study_v1')).sourceReference.revision)).toBe('source-2');
});

test('Permitted draws viewport parcel volumes without a study and zoning areas have their own control @features', async ({ mockApi: page }) => {
  const input=context();
  const envelope={id:'envelope:atlas-study-test:parcel-test:family1',role:'permitted',proposalId:null,parcelEnvelope:true,
    title:'Synthetic parcel envelope',source:{...source,parcel:'parcel-test'},site:geometry,areas:[],
    volumes:[{id:'bound',geometry,baseM:0,topM:10.668}],
    spatialReference:{horizontal:'OGC:CRS84',vertical:'relative-ground',unit:'m'},
    assessment:{meaning:'partial-envelope',status:'unresolved'},metrics:{heightM:10.668,footprintM2:1000},constraints:[],
    sourceEvidence:{parcelReference:input.parcelReference,sourceReferences:[input.sourceReference]}};
  const zone={...input.source,title:'Synthetic zoning area',areas:[{geometry}],volumes:[],metrics:{heightM:null},
    assessment:{meaning:'zoning-area',status:'allowed'}};
  await page.route('**/planning/**', async route => {
    if (!['xhr','fetch'].includes(route.request().resourceType())) return route.fallback();
    const path=new URL(route.request().url()).pathname;
    await route.fulfill({json:path.endsWith('/study') ? input : path.endsWith('/sources') ? {city:'colorado',sources:[source]}
      : {schemaVersion:'planning-representations.v1',city:'colorado',sources:[source],items:path.endsWith('/envelopes')?[envelope]:[zone],
        summaries:[],unavailable:[],coverage:'source-results',nextCursor:null,omitted:0}});
  });
  await page.goto(url.replace('&planningParcel=parcel-test','')); await waitForMapReady(page);
  await expect(page.locator('.planning-envelope-height')).toHaveText('10.7 m',{timeout:45_000});
  expect(await page.evaluate(() => (window as any).PlanningParcelStudy.getContext())).toBeUndefined();
  await page.getByRole('button',{name:'Buildings and massing',exact:true}).click();
  const panel=page.locator('#planning-views');
  await expect(panel.locator('[data-planning-setting="zoningAreas"]')).toHaveValue('off');
  await panel.locator('[data-planning-setting="permitted"]').selectOption('off');
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  await panel.locator('[data-planning-setting="zoningAreas"]').selectOption('ghost');
  await expect(page.getByRole('button',{name:'Inspect source zoning area Synthetic zoning area',exact:true})).toBeAttached();
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  await panel.locator('[data-planning-setting="zoningAreas"]').selectOption('off');
  await panel.locator('[data-planning-setting="permitted"]').selectOption('solid');
  await expect(page.locator('.planning-envelope-height')).toHaveCount(1);
  await page.getByRole('button',{name:'Buildings and massing',exact:true}).click();
  await page.getByRole('button',{name:'Inspect permitted massing on parcel-test',exact:true}).click();
  const inspector=page.locator('#planning-inspector');
  await expect(inspector.getByText('Partial envelope',{exact:true})).toBeVisible();
  await inspector.getByRole('button',{name:'Test a parcel here',exact:true}).click();
  await expect(inspector.getByLabel('Design height (m)')).toBeVisible();
  expect(await page.evaluate(() => (window as any).PlanningViews.getItems().filter((item:any)=>item.parcelEnvelope).length)).toBe(0);
});
