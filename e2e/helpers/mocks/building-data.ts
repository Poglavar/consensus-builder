import { Page } from '@playwright/test';

// Closed roof/wall faces in the actual 3D record wire format (POST /buildings/cell, kind near). One building lies
// inside the test parcel (cleared by a park), the other remains outside the proposal.
function cube(object_id: number, x: number, y: number) {
  const a = [x, y, 0], b = [x + .00012, y, 0], c = [x + .00012, y + .00012, 0], d = [x, y + .00012, 0];
  const top = (p: number[]) => [p[0], p[1], 14];
  return { object_id, z_min: 0, z_max: 14, faces: [
    [top(a), top(b), top(c), top(d), top(a)],
    [a, b, top(b), top(a), a], [b, c, top(c), top(b), b],
    [c, d, top(d), top(c), c], [d, a, top(a), top(d), d],
  ].map(coordinates => ({ type: 'Polygon', coordinates: [coordinates] })) };
}
export const buildings3D = [cube(101, 15.98210, 45.80010), cube(102, 15.98265, 45.80010)];

export async function mockBuildingScene(page: Page): Promise<any[]> {
  const requests: any[] = [];
  // Every building cell answers both buildings; the scene keeps each once, by object_id.
  await page.route('**/buildings/cell', async route => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true,
      items: body.kind === 'near' ? buildings3D : [] } });
  });
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: [] } }));
  await page.route(/\/decor\/near\?/, route => route.fulfill({ json: { trees: [] } }));
  return requests;
}

// Footprint cells (POST /buildings/cell, kind footprints), as the map, the derived demolitions and a
// review read existing buildings: every cell of every source answers `answer(body)` — flat items
// { id, geometry, height_m?, floors? }, which the cell loader files under the cell holding each one's
// first vertex — or 'unavailable', an outage of that cell. Other kinds fall through to earlier routes.
export async function mockFootprintCells(page: Page, answer: (body: any) => any[] | 'unavailable'): Promise<any[]> {
  const requests: any[] = [];
  await page.route('**/buildings/cell', async route => {
    const body = route.request().postDataJSON();
    if (body.kind !== 'footprints') return route.fallback();
    requests.push(body);
    const items = answer(body);
    if (items === 'unavailable') {
      return route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, items: [], complete: false, unavailable: true, retryAfter: 1 } });
    }
    return route.fulfill({ json: { supported: true, kind: body.kind, bbox: body.bbox, complete: true, items } });
  });
  return requests;
}
