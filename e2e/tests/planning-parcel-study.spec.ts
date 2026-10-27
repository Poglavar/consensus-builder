// Permitted inspection remains available; the retired parcel study has no UI or link restoration.
import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import { selectNativeOption } from '../helpers/controls';

test.use({ seedCity: 'colorado' });
const geometry = { type: 'Polygon', coordinates: [[[-104.9907,39.7391],[-104.9902,39.7391],[-104.9902,39.7395],[-104.9907,39.7395],[-104.9907,39.7391]]] };
const source = { id: 'atlas-study-test', city: 'colorado', label: 'Synthetic Atlas study', edition: 'test',
  url: 'https://example.test/source', recordId: 'slice-test', version: 'source-1', scenario: 'family1', scenarios: ['family1','family2','family4'],
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

test('Permitted keeps its envelope controls and ignores retired parcel-study links and drafts @features', async ({ mockApi: page }) => {
  test.setTimeout(90_000);
  const input=context();
  // Two drawable configurations inside one bound: the inner footprint is the western half of the parcel.
  const inner = { type:'Polygon', coordinates:[[[-104.9907,39.7391],[-104.99045,39.7391],[-104.99045,39.7395],[-104.9907,39.7395],[-104.9907,39.7391]]] };
  const configuration = (id:string, topM:number, treatment='allowed') => ({ id, treatment, unavailableReason:null,
    volumes:[{id:`bound:${id}`,geometry:inner,baseM:0,topM}], metrics:{footprintM2:500,heightM:topM}, edgeInterpretations:4,
    lotArea:{ status: id === 'family2' ? 'fail' : 'pass', minimumM2: id === 'family2' ? 4047 : 1012, parcelM2: 1500 },
    constraints:[{quantity:'height',value:topM/0.3048,unit:'ft',bound:'maximum',evidence:'direct',scenario:id}],
    sourceReference:{...input.sourceReference,scenario:id} });
  const envelope={id:'envelope:atlas-study-test:parcel-test',role:'permitted',proposalId:null,parcelEnvelope:true,
    title:'Synthetic parcel envelope',source:{...source,scenario:null,parcel:'parcel-test'},site:geometry,areas:[],
    volumes:[{id:'bound',geometry,baseM:0,topM:13.716}],
    configurations:[configuration('family1',10.668,'hearing'),configuration('family2',13.716),
      {id:'family4',treatment:'allowed',unavailableReason:'missing-direct-height',volumes:[],metrics:{footprintM2:null,heightM:null},constraints:[],edgeInterpretations:0}],
    derivation:{parcel:geometry,covered:geometry,frontEdges:[0,1,2,3]},
    spatialReference:{horizontal:'OGC:CRS84',vertical:'relative-ground',unit:'m'},
    assessment:{meaning:'outer-bound',status:'unresolved'},metrics:{heightM:13.716,footprintM2:1000},constraints:[],
    sourceEvidence:{parcelReference:input.parcelReference,zoningRecordId:'slice-test',frontEdge:0,excludedConfigurations:{family3:'prohibited'}}};
  const zone={...input.source,title:'Synthetic zoning area',areas:[{geometry}],volumes:[],metrics:{heightM:null},
    assessment:{meaning:'zoning-area',status:'allowed'}};
  let envelopeReads = 0, studyReads = 0;
  const savedDraft = JSON.stringify({ schemaVersion: 'planning-parcel-study.v1', form: { heightM: 12 } });
  await page.addInitScript(value => {
    try {
      localStorage.setItem('cb_planning_parcel_study_v1', value);
    } catch (_) { /* opaque origin */ }
  }, savedDraft);
  // Keep the independent cadastral source offline too, so its recovery UI cannot cover the controls.
  await page.route('**/Colorado_Public_Parcels/FeatureServer/0**', async route => {
    const params = new URL(route.request().url()).searchParams;
    const attributes = { OBJECTID: 1, parcel_id: 'fixture', countyName: 'Denver' };
    const json = params.get('returnIdsOnly') === 'true' ? { objectIdFieldName: 'OBJECTID', objectIds: [1] }
      : params.get('returnCountOnly') === 'true' ? { count: 1 }
      : params.get('f') === 'geojson' ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: attributes, geometry }] }
      : { geometryType: 'esriGeometryPolygon', spatialReference: { wkid: 4326 },
        features: [{ attributes, geometry: { rings: geometry.coordinates } }] };
    await route.fulfill({ json });
  });
  await page.route('**/planning/**', async route => {
    if (!['xhr','fetch'].includes(route.request().resourceType())) return route.fallback();
    const path=new URL(route.request().url()).pathname;
    if (path.endsWith('/envelopes')) envelopeReads++;
    if (path.endsWith('/study')) studyReads++;
    await route.fulfill({json:path.endsWith('/study') ? input : path.endsWith('/sources') ? {city:'colorado',sources:[source]}
      : {schemaVersion:'planning-representations.v1',city:'colorado',sources:[source],items:path.endsWith('/envelopes')?[envelope]:[zone],
        summaries:[],unavailable:[],coverage:'source-results',nextCursor:null,omitted:0}});
  });
  // Source selection is a frontend city setting; the backend catalog does not choose a default.
  await page.route(/\/js\/city-config\.js(?:\?|$)/, async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('colorado: {', `colorado: { planning: { sourceIds: [${JSON.stringify(source.id)}] },`);
    await route.fulfill({ response, body });
  });
  await page.goto(url.replace('planningScenario=family1','planningScenario=all') + '&planningStudyScenario=family1'); await waitForMapReady(page);
  // The map keeps the selected envelope geometry while leaving height metrics to the inspector.
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems().filter((item:any) => item.parcelEnvelope).length)).toBe(1);
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0,{timeout:45_000});
  const shown = async () => page.evaluate(() => { const shown = (window as any).PlanningViews.permittedFeatures((window as any).PlanningViews.getItems()[0]);
    return { configuration: shown.configuration.id, frontEdge: shown.frontEdge }; });
  const shownGeometry = () => page.evaluate(() => {
    const w = window as any, shown = w.PlanningViews.permittedFeatures(w.PlanningViews.getItems()[0]);
    const features = shown.body.length ? shown.body : shown.bound;
    return features.map((feature:any) => ({ type: feature.geometry?.type, coordinates: feature.geometry?.coordinates,
      topM: feature.properties.topM, geometryRole: feature.properties.geometryRole }));
  });
  const expectShownGeometry = async () => {
    const features = await shownGeometry();
    expect(features.length).toBeGreaterThan(0);
    for (const feature of features) {
      expect(feature.type).toBe('Polygon');
      expect(feature.coordinates?.[0]?.length).toBeGreaterThanOrEqual(4);
      expect(Number.isFinite(feature.topM)).toBe(true);
      expect(feature.topM).toBeGreaterThan(0);
    }
    await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  };
  const first = await shown();
  // Two-family is flagged below its minimum lot, so the roll keeps the parcel on one-family.
  expect(first.configuration).toBe('family1');
  await expectShownGeometry();
  expect(studyReads).toBe(0);
  await page.getByRole('button',{name:'Buildings and massing',exact:true}).click();
  const panel=page.locator('#planning-views');
  await expect(panel.locator('.planning-scenario-select')).toHaveValue('all');
  // The housing type roll preserves frontage evidence; pinning a type overrides the roll.
  const proposedBeforeRoll = await page.evaluate(() => (window as any).PlanningViews.getState().proposedVariation);
  await panel.locator('#planning-reroll-permitted').click();
  const rolled = await shown();
  expect(rolled.frontEdge).toBe(first.frontEdge); expect(rolled.configuration).toBe('family1');
  expect(await page.evaluate(() => (window as any).PlanningViews.getState().proposedVariation)).toBe(proposedBeforeRoll);
  await panel.locator('#planning-reroll').click();
  expect(await shown()).toEqual(rolled);
  await selectNativeOption(panel.locator('.planning-scenario-select'), 'family2');
  await expectShownGeometry();
  expect((await shown()).configuration).toBe('family2');
  await selectNativeOption(panel.locator('.planning-scenario-select'), 'all');
  // Envelopes carry every housing type: the control redraws them without another viewport read.
  expect(envelopeReads).toBe(1);
  await selectNativeOption(panel.locator('[data-planning-setting="permittedForm"]'), 'bound');
  await expectShownGeometry();
  await selectNativeOption(panel.locator('[data-planning-setting="permittedForm"]'), 'both');
  await expect(panel.locator('[data-planning-setting="zoningAreas"]')).toHaveValue('off');
  await selectNativeOption(panel.locator('[data-planning-setting="permitted"]'), 'off');
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  await selectNativeOption(panel.locator('[data-planning-setting="zoningAreas"]'), 'ghost');
  await expect(page.getByRole('button',{name:'Inspect source zoning area Synthetic zoning area',exact:true})).toBeAttached();
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  await selectNativeOption(panel.locator('[data-planning-setting="zoningAreas"]'), 'off');
  await selectNativeOption(panel.locator('[data-planning-setting="permitted"]'), 'solid');
  await expectShownGeometry();
  await page.getByRole('button',{name:'Buildings and massing',exact:true}).click();
  await page.getByRole('button',{name:'Inspect permitted massing on parcel-test',exact:true}).click();
  const inspector=page.locator('#planning-inspector');
  await expect(inspector.getByText('Permitted envelope',{exact:true})).toBeVisible();
  await expect(inspector.locator('.planning-configurations__pick')).toHaveCount(3);
  await expect(inspector.locator('[data-configuration="family4"]')).toContainText('No direct height limit');
  await expect(inspector.locator('[data-configuration="family2"]')).toContainText('Lot below the');
  await expect(inspector.locator('[data-configuration="family1"]')).not.toContainText('Lot below the');
  await expect(inspector.getByText('Not configurable here: Three-family (Recorded as prohibited).')).toBeVisible();
  // Picking a configuration pins it for this parcel; the inspector marks it and the map follows.
  await inspector.locator('[data-configuration="family1"] button').click();
  await expect(inspector.locator('[data-configuration="family1"] button')).toHaveAttribute('aria-pressed','true');
  await expectShownGeometry();
  await expect(inspector.getByText(/^Assumed street side: (north|east|south|west)\./)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Test a parcel here', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-study-input], [data-study-results]')).toHaveCount(0);
  // A fixed housing type still rolls a new sample; busy feedback covers the resulting 3D frame
  // even with reduceMotion=1, and replacement meshes retain their shadows immediately.
  await page.locator('#mode-3d-toggle').click();
  await expect.poll(() => page.evaluate(() => !!(window as any).getThreeModeInternals?.())).toBe(true);
  await page.evaluate(() => (window as any).ThreeSceneReady.wait({ requireExisting: false }));
  await page.getByRole('button',{name:'Buildings and massing',exact:true}).click();
  await selectNativeOption(panel.locator('.planning-scenario-select'), 'family1');
  const beforeSample = await page.evaluate(() => JSON.stringify((window as any).PlanningViews.permittedFeatures((window as any).PlanningViews.getItems()[0]).body));
  const busy = await page.evaluate(() => {
    const w = window as any;
    w.__finishRoll = null;
    const wait = w.ThreeSceneReady.wait.bind(w.ThreeSceneReady);
    w.__restoreRollWait = () => { w.ThreeSceneReady.wait = wait; };
    w.ThreeSceneReady.wait = async (options:any) => {
      await wait(options);
      await new Promise(resolve => { w.__finishRoll = resolve; });
    };
    const button = document.getElementById('planning-reroll-permitted')!;
    button.click();
    return { busy: button.getAttribute('aria-busy'), ring: button.classList.contains('cb-busy') };
  });
  expect(busy).toEqual({ busy:'true', ring:true });
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishRoll)).toBe('function');
  await expect(panel.locator('#planning-reroll-permitted')).toHaveAttribute('aria-busy','true');
  expect(await page.evaluate(() => JSON.stringify((window as any).PlanningViews.permittedFeatures((window as any).PlanningViews.getItems()[0]).body))).not.toBe(beforeSample);
  await expect(panel.locator('.planning-scenario-select')).toHaveValue('family1');
  const shadows = await page.evaluate(() => {
    const flags:boolean[] = [];
    (window as any).getThreeModeInternals().scene.traverse((mesh:any) => {
      if (mesh.isMesh && mesh.userData.planningRepresentationId && mesh.material.opacity >= 0.15) flags.push(mesh.castShadow);
    });
    return flags;
  });
  expect(shadows.length).toBeGreaterThan(0);
  expect(shadows.every(Boolean)).toBe(true);
  await page.evaluate(() => { const w=window as any; w.__restoreRollWait(); w.__finishRoll(); });
  await expect(panel.locator('#planning-reroll-permitted')).not.toHaveAttribute('aria-busy','true');
  await page.locator('#mode-2d-toggle').click();
  await page.screenshot({ path: '/tmp/permitted-without-parcel-study.png' });
  await page.reload();
  await waitForMapReady(page);
  await expect.poll(() => page.evaluate(() => (window as any).PlanningViews.getItems().filter((item:any) => item.parcelEnvelope).length)).toBe(1);
  await expect(page.locator('.planning-envelope-height')).toHaveCount(0);
  expect(studyReads).toBe(0);
  await expect(page.locator('[data-study-input], [data-study-results]')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('cb_planning_parcel_study_v1'))).toBe(savedDraft);
});
