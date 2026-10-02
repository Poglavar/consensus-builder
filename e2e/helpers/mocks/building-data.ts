import { Page } from '@playwright/test';

// Closed roof/wall faces in the actual /buildings/near wire format. One building lies
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
  await page.route('**/buildings/near', async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { buildings: buildings3D } });
  });
  await page.route('**/decor/layers**', route => route.fulfill({ json: { layers: [] } }));
  await page.route('**/decor/near', route => route.fulfill({ json: { trees: [] } }));
  return requests;
}
