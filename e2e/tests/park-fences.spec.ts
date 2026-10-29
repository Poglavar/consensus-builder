// Fenced areas in parks (js/park-enclosures.js): the park editor's Fence the whole park, Fenced area,
// Gate and Swing tools and the fenced area's card write decorationDesign.enclosures and swings, which
// the 2D map draws as styled fences, a play area's ground and its sign, and the model view as fence boxes.
import { test, expect } from '../helpers/fixtures';
import { openCity, createSpace, showProposal } from '../helpers/runtime';
import { mockBuildingScene } from '../helpers/mocks/building-data';
import { Locator, Page } from '@playwright/test';

// A rectangle inside the fixture park (parcel HR-335754-1234: 15.9819–15.9825 E, 45.8000–45.8005 N).
const AREA = [[15.98196, 45.80006], [15.98222, 45.80006], [15.98222, 45.80024], [15.98196, 45.80024]];

// The park's generated footpaths, trees and ponds take their own clicks, so a person places a point on
// free ground: the nearest spot (within a few pixels) where nothing on the map is under the pointer.
async function clickFreeGround(page: Page, lng: number, lat: number) {
  const spot = await page.evaluate(({ lng, lat }) => {
    const w = window as any;
    const box = w.map.getContainer().getBoundingClientRect();
    const at = w.map.latLngToContainerPoint([lat, lng]);
    for (let r = 0; r <= 24; r += 4) {
      for (const [dx, dy] of r ? [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]] : [[0, 0]]) {
        const x = box.left + at.x + dx, y = box.top + at.y + dy;
        const target = document.elementFromPoint(x, y);
        if (target?.closest('#map') && !target.closest('.structure-geometry-draggable, .structure-geometry-fence, .leaflet-marker-icon')) return { x, y };
      }
    }
    return null;
  }, { lng, lat });
  if (!spot) throw new Error(`no free ground near ${lng},${lat}`);
  await page.mouse.click(spot.x, spot.y);
}

// A point on the drawn area's south fence clear of its gates, where the fence itself is under the pointer.
async function southFenceSpot(page: Page) {
  const spot = await page.evaluate(([[west, south], [east]]) => {
    const w = window as any;
    const box = w.map.getContainer().getBoundingClientRect();
    const gates = [...document.querySelectorAll('.structure-geometry-icon.is-gate')].map(el => {
      const r = el.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    });
    for (const f of [0.25, 0.75, 0.35, 0.65, 0.15, 0.85]) {
      const p = w.map.latLngToContainerPoint([south, west + (east - west) * f]);
      const x = box.left + p.x, y = box.top + p.y;
      const onFence = document.elementFromPoint(x, y)?.closest('path.structure-geometry-fence');
      if (onFence && gates.every(([gx, gy]) => Math.hypot(gx - x, gy - y) > 30)) return { x, y };
    }
    return null;
  }, AREA);
  if (!spot) throw new Error('no clear stretch of the south fence');
  return spot;
}

const gatesIn = async (card: Locator) => Number((await card.locator('[data-role="enclosure-summary"]').textContent())?.match(/gates: (\d+)/)?.[1]);

test('fences the park and a play area with gates and a swing, saved and drawn in 2D and in the model view', async ({ mockApi: page }) => {
  await mockBuildingScene(page);
  await openCity(page);
  const proposalId = await createSpace(page, 'park');
  await showProposal(page, proposalId);
  await page.locator('#proposal-details-footer .btn-edit-geometry').click();
  const editor = page.locator('#structure-geometry-editor');
  await expect(editor.locator('.on-map-editor__panel')).toBeVisible();
  const card = editor.locator('[data-role="enclosure-card"]');
  // Nothing is selected yet, so the card stays hidden (soft: the rest of the flow is still checked).
  await expect.soft(card).toBeHidden();

  // A fence around the whole park: wrought iron and open by default, then switched to mesh.
  await editor.locator('[data-action="fence-park"]').click();
  await expect(card).toBeVisible();
  await expect(card.locator('[data-role="enclosure-summary"]')).toContainText('Fence around the whole park, gates: ');
  expect(await gatesIn(card)).toBeGreaterThan(0);
  await expect(card.locator('[data-enclosure-fence="iron"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-enclosure-use="none"]')).toHaveAttribute('aria-pressed', 'true');
  await card.locator('[data-enclosure-fence="mesh"]').click();
  await expect(card.locator('[data-enclosure-fence="mesh"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-enclosure-fence="iron"]')).toHaveAttribute('aria-pressed', 'false');

  // A fenced area drawn inside the park: Finish area waits for three points.
  await page.evaluate(() => (window as any).map.setView([45.80015, 15.98209], 20, { animate: false }));
  await editor.locator('[data-tool="enclosure"]').click();
  const finish = editor.locator('[data-action="finish-area"]');
  await expect(finish).toBeVisible();
  for (const [index, [lng, lat]] of AREA.entries()) {
    if (index < 3) await expect(finish).toBeDisabled();
    await clickFreeGround(page, lng, lat);
  }
  await expect(finish).toBeEnabled();
  await finish.click();
  await expect(card.locator('[data-role="enclosure-summary"]')).toContainText('Fenced area, gates: ');
  await expect(card.locator('[data-enclosure-fence="iron"]')).toHaveAttribute('aria-pressed', 'true');
  // A play area: its default fence (iron for an open area) follows the use to mesh.
  await card.locator('[data-enclosure-use="play"]').click();
  await expect(card.locator('[data-enclosure-use="play"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.locator('[data-enclosure-fence="mesh"]')).toHaveAttribute('aria-pressed', 'true');
  const defaultGates = await gatesIn(card);
  expect(defaultGates).toBeGreaterThan(0);

  // The Gate tool puts a gate in the fence where it is clicked, and takes it out again.
  await editor.locator('[data-tool="gate"]').click();
  const gateAt = await southFenceSpot(page);
  await page.mouse.click(gateAt.x, gateAt.y);
  await expect.poll(() => gatesIn(card)).toBe(defaultGates + 1);
  await page.mouse.click(gateAt.x, gateAt.y);
  await expect.poll(() => gatesIn(card)).toBe(defaultGates);
  await page.mouse.click(gateAt.x, gateAt.y);
  await expect.poll(() => gatesIn(card)).toBe(defaultGates + 1);

  // A swing on the lawn outside the play area.
  await editor.locator('[data-tool="swing"]').click();
  await clickFreeGround(page, 15.98232, 45.80040);
  await expect(page.locator('.structure-geometry-icon.is-play')).toHaveCount(1);

  await editor.locator('[data-action="save"]').click();
  await expect(editor).toHaveCount(0);
  const design = await page.evaluate(id => JSON.parse(JSON.stringify((window as any).getProposalByIdOrHash(id).structureProposal.decorationDesign)), proposalId);
  expect(design.enclosures).toHaveLength(2);
  const [wholePark, playArea] = design.enclosures;
  expect(wholePark).toMatchObject({ fence: 'mesh', use: 'none' });
  expect(wholePark.ring).toBeUndefined();
  expect(playArea).toMatchObject({ fence: 'mesh', use: 'play' });
  // The drawn rectangle (vertices may snap to nearby edges, so compare the enclosed area).
  const areas = await page.evaluate(({ ring, area }) => {
    const turf = (window as any).turf;
    return { drawn: turf.area(turf.polygon([ring])), intended: turf.area(turf.polygon([[...area, area[0]]])), points: ring.length };
  }, { ring: playArea.ring, area: AREA });
  expect(areas.points, JSON.stringify(playArea.ring)).toBeGreaterThanOrEqual(4);
  expect(Math.abs(areas.drawn - areas.intended) / areas.intended, JSON.stringify(areas)).toBeLessThan(0.15);
  expect(playArea.gates).toHaveLength(defaultGates + 1);
  expect(design.swings).toHaveLength(1);

  // The 2D map: mesh fences split at their gates, the play area's rubber ground and its sign, the swing.
  expect(await page.locator('#map path.park-fence.is-mesh').count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('#map path.park-fence.is-iron')).toHaveCount(0);
  await expect(page.locator('#map path.park-enclosure-ground.is-rubber')).toHaveCount(1);
  await expect(page.locator('#map .structure-furniture-glyph.is-area.is-play')).toHaveCount(1);
  await expect(page.locator('#map .structure-furniture-glyph.is-gate')).toHaveCount(wholePark.gates.length + playArea.gates.length);

  // The model view builds the fences as instanced boxes: the see-through mesh infill is among them.
  await page.locator('#mode-3d-toggle').click();
  await expect(page.locator('#three-container canvas')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => page.evaluate(() => {
    const scene = (window as any).getThreeModeInternals?.()?.scene;
    let infill = 0;
    scene?.traverse((object: any) => {
      const material = object.material;
      if (object.isInstancedMesh && material?.transparent && material.opacity === 0.35 && material.color?.getHex() === 0x2f4f3a) infill += object.count;
    });
    return infill;
  }), { timeout: 20_000 }).toBeGreaterThan(0);
});
