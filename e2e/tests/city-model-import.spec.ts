// CityGML in the building editors (js/city-model-reader.js): a CityGML 2.0 building in EPSG:3765,
// uploaded through the Block editor's footprint import, opens as an editable Freeform footprint with
// its measured height, read through the browser's DOMParser; an unknown coordinate system is named.
import { test, expect } from '../helpers/fixtures';
import { openCity, openParcel, openBlockEditor, placeFreeformBuilding, stubBasemapTiles } from '../helpers/runtime';
import { mockFootprintCells } from '../helpers/mocks/building-data';

// The same 4-corner outline as the Upload GeoJSON test, as EPSG:3765 metres, 12 m high.
const ring = [[459733.799, 5073490.275], [459761.005, 5073490.099], [459761.149, 5073512.326], [459733.943, 5073512.502]];
const posList = (z: number) => [...ring, ring[0]].map(([x, y]) => `${x} ${y} ${z}`).join(' ');
const cityGml = (srs: string) => `<?xml version="1.0" encoding="UTF-8"?>
<core:CityModel xmlns:core="http://www.opengis.net/citygml/2.0" xmlns:bldg="http://www.opengis.net/citygml/building/2.0" xmlns:gml="http://www.opengis.net/gml">
  <core:cityObjectMember><bldg:Building gml:id="fixture-building">
    <bldg:measuredHeight uom="m">12</bldg:measuredHeight>
    <bldg:boundedBy><bldg:GroundSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
      <gml:posList srsName="${srs}" srsDimension="3">${posList(120)}</gml:posList>
    </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:GroundSurface></bldg:boundedBy>
    <bldg:boundedBy><bldg:RoofSurface><bldg:lod2MultiSurface><gml:MultiSurface><gml:surfaceMember><gml:Polygon><gml:exterior><gml:LinearRing>
      <gml:posList srsDimension="3">${posList(132)}</gml:posList>
    </gml:LinearRing></gml:exterior></gml:Polygon></gml:surfaceMember></gml:MultiSurface></bldg:lod2MultiSurface></bldg:RoofSurface></bldg:boundedBy>
  </bldg:Building></core:cityObjectMember>
</core:CityModel>`;

async function uploadIntoBlockEditor(page: any, text: string) {
  await openCity(page);
  await openParcel(page, 'proposals');
  await openBlockEditor(page);
  await expect(page.locator('#btn-blockify-done')).toBeEnabled({ timeout: 20_000 });
  const upload = page.locator('#blockify-geojson-upload');
  if (!(await upload.isVisible())) await page.locator('#blockify-modal .on-map-editor__more-options > summary').click();
  await expect(upload).toHaveAttribute('title', 'GeoJSON, CityGML or CityJSON');
  const chooser = page.waitForEvent('filechooser');
  await upload.click();
  await (await chooser).setFiles({ name: 'building.gml', mimeType: 'application/gml+xml', buffer: Buffer.from(text) });
}

test('a CityGML building opens as an editable Freeform footprint with its measured height', async ({ mockApi: page }) => {
  await uploadIntoBlockEditor(page, cityGml('EPSG:3765'));
  await expect(page.locator('#single-building-editor .on-map-editor__panel')).toBeVisible();
  await expect(page.locator('#map-container .polygon-geometry-editor__vertex')).toHaveCount(4);
  await expect(page.locator('#single-land-take [data-land-status]')).toContainText('m²', { timeout: 20_000 });
  await page.locator('#single-building-confirm').click();
  const saved = () => page.evaluate(() => (window as any).proposalStorage.getAllProposals()
    .flatMap((p: any) => p.geometry?.buildings || []).find((b: any) => b.properties?.height === 12) || null);
  await expect.poll(saved, { timeout: 20_000 }).not.toBeNull();
  const building = await saved();
  const [lng, lat] = building.geometry.coordinates[0][0];
  expect(lng).toBeCloseTo(15.9820, 4);
  expect(lat).toBeCloseTo(45.8001, 4);
});

test('a CityGML file in a coordinate system we cannot read says which one', async ({ mockApi: page }) => {
  await uploadIntoBlockEditor(page, cityGml('EPSG:5514'));
  await expect(page.locator('.cb-dialog').filter({ hasText: 'EPSG:5514' })).toContainText('is not one we can read yet');
});

test('Upload model takes a CityGML building as a GLB that stands where the file puts it', async ({ mockApi: page }) => {
  const uploads: string[] = [];
  await mockFootprintCells(page, () => []);
  await page.route('**/models', route => { uploads.push(route.request().postDataJSON().modelData); return route.fulfill({ json: { modelUrl: '/uploads/models/building.glb' } }); });
  await stubBasemapTiles(page);
  await openCity(page);
  await openParcel(page, 'proposals');
  await page.locator('#parcel-info-panel .parcel-build-btn--single').click();
  await placeFreeformBuilding(page);
  await expect(page.locator('#single-building-glb-upload')).toHaveAttribute('title', 'glTF, CityGML or CityJSON');
  await page.locator('#single-building-glb-upload').click();
  const upload = page.locator('#building-upload-modal');
  await upload.locator('#building-upload-file').setInputFiles({ name: 'building.gml', mimeType: 'application/gml+xml', buffer: Buffer.from(cityGml('EPSG:3765')) });
  await expect(upload.locator('#building-upload-confirm')).toBeEnabled({ timeout: 45_000 });
  await upload.locator('#building-upload-confirm').click();
  await expect(upload).toHaveCount(0);
  // The uploaded asset is a GLB ("glTF" magic), not the CityGML text.
  expect(uploads).toHaveLength(1);
  expect(Buffer.from(uploads[0].split(',')[1], 'base64').subarray(0, 4).toString()).toBe('glTF');
  const [feature] = await page.evaluate(() => (window as any).OnMapEditor.getPreview().draftPreview.features);
  expect(feature.properties).toMatchObject({ modelName: 'building.gml', modelUrl: '/uploads/models/building.glb', height: 12 });
  const lngs = feature.geometry.coordinates[0].map((p: number[]) => p[0]), lats = feature.geometry.coordinates[0].map((p: number[]) => p[1]);
  expect(Math.min(...lngs)).toBeCloseTo(15.9820, 4); expect(Math.max(...lngs)).toBeCloseTo(15.98235, 4);
  expect(Math.min(...lats)).toBeCloseTo(45.8001, 4); expect(Math.max(...lats)).toBeCloseTo(45.8003, 4);
});
