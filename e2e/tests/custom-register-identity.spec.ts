import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test('custom register references stay source-qualified after UI selection and reload', async ({ mockApi: page }) => {
  const geometry = { type: 'Polygon', coordinates: [[[-0.121, 51.499], [-0.119, 51.499],
    [-0.119, 51.501], [-0.121, 51.501], [-0.121, 51.499]]] };
  await page.route('**/semantic-register-*.geojson', route => route.fulfill({ json: {
    type: 'FeatureCollection', features: [{ type: 'Feature', properties: { OBJECTID: 7 }, geometry }]
  } }));
  await page.goto('/?city=london&at=51.5,-0.12,18&lang=en&reduceMotion=1');
  await waitForMapReady(page);
  const references: string[] = [];
  for (const name of ['a', 'b']) {
    const url = new URL(`/semantic-register-${name}.geojson`, page.url()).href;
    await page.evaluate(() => (window as any).ParcelGroundFallback.openOptions());
    await page.locator('.ground-fallback-option[data-option="url"]').click();
    await page.locator('.ground-fallback-input').fill(url);
    await page.getByRole('button', { name: 'Check and use this link' }).click();
    await page.waitForFunction(url => {
      const w = window as any, source = w.ParcelGroundFallback?.activeSource();
      return source?.url === url && w.CadastralParcelRepository?.list().some((f: any) => f.properties.sourceId === source.id);
    }, url);
    const facts = await page.evaluate(() => {
      const w = window as any, source = w.ParcelGroundFallback.activeSource();
      const features = w.CadastralParcelRepository.list().filter((f: any) => f.properties.sourceId === source.id);
      return { source: source.id, features: features.map((f: any) => f.properties) };
    });
    expect(facts.source).toMatch(/^custom-url:sha256:[a-f0-9]{64}$/);
    expect(facts.features).toHaveLength(1);
    expect(facts.features[0]).toMatchObject({ sourceId: facts.source, sourceParcelId: '7', sourceIdentityKind: 'native-id' });
    references.push(facts.features[0].parcelId);
    await page.reload();
    await page.waitForFunction(id => !!(window as any).CadastralParcelRepository?.get(id), references.at(-1));
  }
  expect(references[0]).not.toBe(references[1]);
  const stale = await page.evaluate(id => {
    const w = window as any;
    return { retained: w.CadastralParcelRepository.get(id), lookup: w.ParcelGroundFallback.activeSource().fetchByIds([id]) };
  }, references[0]);
  expect(stale.retained).toBeFalsy();
  expect(stale.lookup).toEqual({ features: [], absentIds: [references[0]] });
});
