// Exercise the shared relationship renderer with long parcel IDs and design titles at phone and desktop widths.
import { test, expect } from '../helpers/fixtures';

for (const width of [360, 390, 1280]) {
  test(`relationship lists keep one item per row and truncate labels at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/__relationship-layout', route => route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head>
        <link rel="stylesheet" href="/css/tokens.css">
        <link rel="stylesheet" href="/css/primitives.css">
        <link rel="stylesheet" href="/css/panels.css">
        <link rel="stylesheet" href="/css/right-screen-panel.css">
        <link rel="stylesheet" href="/css/map.css">
      </head><body></body></html>`,
    }));
    await page.goto('/__relationship-layout');
    await page.addScriptTag({ url: '/js/ui/object-list.js' });
    await page.addScriptTag({ url: '/js/click-stack/click-stack-relations.js' });

    for (const stackId of ['click-stack', 'three-click-stack']) {
      for (const plan of [false, true]) {
        await page.evaluate(({ stackId, plan }) => {
          document.body.replaceChildren();
          const stack = document.createElement('aside');
          stack.id = stackId;
          stack.className = 'click-stack right-dock-panel right-screen-panel';
          const section = document.createElement('section');
          section.className = 'click-stack__section is-expanded';
          const body = document.createElement('div');
          body.className = `click-stack__body${plan ? ' click-stack__plan' : ''}`;
          for (const kind of ['parcels', 'designs']) {
            body.append((window as any).ClickStackRelations.renderGroup({
              kind, relation: kind === 'parcels' ? 'formedParcels' : 'designsOnParcel',
              instances: [
                { id: 'long', label: kind === 'parcels'
                  ? `2931#design-${'bafkreibwmhm6gtdpvaac4qtx7hnd7bnqj47d4ewbbw375bhaoof42csddi'}-9`
                  : 'Parcel layout with a long descriptive title that exceeds the width of the inspection card' },
                { id: 'short', label: kind === 'parcels' ? '2931 #2' : 'Block' },
                { id: 'third', label: kind === 'parcels' ? '2931 #3' : 'Streets' },
              ],
            }, document, window));
          }
          section.append(body); stack.append(section); document.body.append(stack);
        }, { stackId, plan });

        for (const kind of ['parcels', 'designs']) {
          const group = page.locator(`#${stackId} .click-stack__choices[data-kind="${kind}"]`);
          const rows = group.locator('.click-stack__link');
          await expect(rows).toHaveCount(3);
          const boxes = await rows.evaluateAll(items => items.map(item => {
            const row = item.getBoundingClientRect();
            const chip = item.querySelector('.click-stack__chip')!;
            const label = item.querySelector('.click-stack__chip-label')!;
            const open = item.querySelector('.click-stack__open')!.getBoundingClientRect();
            const css = getComputedStyle(label);
            return { x: row.x, y: row.y, width: row.width, height: row.height, right: row.right,
              openX: open.x, openRight: open.right, openWidth: open.width, openHeight: open.height,
              chipRight: chip.getBoundingClientRect().right, title: chip.getAttribute('title'), text: label.textContent,
              clipped: label.scrollWidth > label.clientWidth, overflow: css.textOverflow, whiteSpace: css.whiteSpace };
          }));
          for (const [index, box] of boxes.entries()) {
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.right).toBeLessThanOrEqual(width);
            expect(box.width).toBeCloseTo(boxes[0].width, 0);
            expect(box.height).toBeCloseTo(boxes[1].height, 0);
            expect(box.openRight).toBeLessThanOrEqual(box.right);
            expect(box.chipRight).toBeLessThanOrEqual(box.openX);
            expect(box.openWidth).toBeGreaterThanOrEqual(32);
            expect(box.openHeight).toBeGreaterThanOrEqual(32);
            expect(box.title).toBe(box.text);
            expect(box.overflow).toBe('ellipsis');
            expect(box.whiteSpace).toBe('nowrap');
            if (index > 0) expect(box.y).toBeGreaterThanOrEqual(boxes[index - 1].y + boxes[index - 1].height);
          }
          expect(boxes[0].clipped).toBe(true);
          expect(boxes[1].clipped).toBe(false);
        }
      }
    }
  });
}
