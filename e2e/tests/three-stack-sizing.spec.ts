// Exercise the real stack DOM and styles without booting the 3D renderer or source APIs.
import { test, expect } from '@playwright/test';
import path from 'node:path';

const frontend = path.resolve(__dirname, '../../frontend');

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test.describe(`3D click stack sizing at ${viewport.width}px`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await page.setContent('<!doctype html><html><body class="three-mode-active"><main id="map-container"></main></body></html>');
      for (const file of ['tokens', 'primitives', 'base', 'map', 'panels', 'utilities', 'map-shell', 'planning-views', 'mobile-sheets', 'three-click-stack']) {
        await page.addStyleTag({ path: path.join(frontend, `css/${file}.css`) });
      }
      await page.addScriptTag({ path: path.join(frontend, 'js/three-click-stack.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/mobile-dock-sheet.js') });
    });

    for (const scenario of [
      { kind: 'built', paragraphs: 1, hosted: true },
      { kind: 'built', paragraphs: 70, hosted: true },
      { kind: 'designs', paragraphs: 70, hosted: false },
    ]) {
      test(`${scenario.kind} with ${scenario.paragraphs} paragraphs fits content and keeps the other headings visible`, async ({ page }) => {
        await page.evaluate(({ kind, paragraphs, hosted }) => {
          const w = window as any;
          const input = Object.fromEntries(['built', 'designs', 'permitted', 'parcels'].map(kind => [kind, [{ id: kind }]]));
          w.ThreeClickStack.show(input, { focus: kind, container: document.getElementById('map-container') }, {
            activate(_kind: string, _instance: unknown, body: HTMLElement) {
              const panel = document.createElement('div');
              panel.className = hosted ? 'planning-inspector is-hosted' : 'three-mode-parcel-panel';
              if (hosted) {
                panel.id = 'planning-inspector';
                const metrics = document.createElement('dl');
                metrics.className = 'planning-metrics';
                for (const [label, value] of [['Footprint', '140 m²'], ['Height', '9 m'], ['Floors', '3'], ['Floor area', '420 m²']]) {
                  const item = document.createElement('div');
                  const term = document.createElement('dt');
                  term.textContent = label;
                  const definition = document.createElement('dd');
                  definition.textContent = value;
                  item.append(term, definition);
                  metrics.appendChild(item);
                }
                panel.appendChild(metrics);
              }
              for (let i = 0; i < paragraphs; i++) {
                const p = document.createElement('p');
                p.textContent = `Source measurement ${i + 1}`;
                panel.appendChild(p);
              }
              body.appendChild(panel);
            },
          });
        }, scenario);

        // Four section headings plus source metrics exceed half of a short phone screen.
        // Give the short record room to fit, then check that the sheet uses only that content.
        if (scenario.paragraphs === 1 && viewport.width < 768) {
          await page.locator('#three-click-stack > .mobile-dock-sheet-handle').focus();
          await page.keyboard.press('End');
        }

        const metrics = await page.evaluate(() => {
          const stack = document.querySelector('#three-click-stack')!;
          const body = stack.querySelector('.click-stack__body')!;
          const content = body.firstElementChild!;
          return {
            stack: stack.getBoundingClientRect().toJSON(),
            body: body.getBoundingClientRect().toJSON(),
            content: content.getBoundingClientRect().toJSON(),
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            stackScrollHeight: stack.scrollHeight,
            stackClientHeight: stack.clientHeight,
            headings: [...stack.querySelectorAll('.click-stack__heading')].map(el => el.getBoundingClientRect().toJSON()),
            maxHeight: parseFloat(getComputedStyle(stack).maxHeight),
          };
        });
        expect(metrics.stack.height).toBeLessThanOrEqual(metrics.maxHeight + 1);
        if (scenario.hosted) {
          const compact = await page.locator('.planning-metrics').evaluate(el => {
            const items = [...el.children];
            return {
              firstRow: items.slice(0, 2).map(item => item.getBoundingClientRect().top),
              sizes: [...el.querySelectorAll('dd')].map(item => getComputedStyle(item).fontSize),
              base: getComputedStyle(el).getPropertyValue('--cb-text-base').trim(),
            };
          });
          expect(compact.firstRow[0]).toBe(compact.firstRow[1]);
          expect(compact.sizes).toEqual(Array(4).fill(compact.base));
        }
        expect(metrics.stackScrollHeight).toBeLessThanOrEqual(metrics.stackClientHeight + 1);
        for (const heading of metrics.headings) {
          expect(heading.height).toBeGreaterThanOrEqual(40);
          expect(heading.bottom).toBeLessThanOrEqual(metrics.stack.bottom + 1);
        }
        if (scenario.paragraphs === 1) {
          expect(metrics.body.height - metrics.content.height).toBeLessThan(20);
          expect(metrics.stack.height).toBeLessThan(metrics.maxHeight);
          expect(metrics.bodyScrollHeight).toBeLessThanOrEqual(metrics.bodyClientHeight + 1);
        } else {
          expect(metrics.stack.height).toBeCloseTo(metrics.maxHeight, 0);
          expect(metrics.bodyScrollHeight).toBeGreaterThan(metrics.bodyClientHeight + 100);
          await page.locator('.click-stack__body').evaluate(el => { el.scrollTop = el.scrollHeight; });
          await expect(page.locator('.click-stack__body p').last()).toBeInViewport();
        }
      });
    }

    test('collapsing a section shrinks the panel, including after resizing it', async ({ page }) => {
      await page.evaluate(() => {
        const w = window as any;
        const input = Object.fromEntries(['built', 'designs', 'permitted', 'parcels'].map(kind => [kind, [{ id: kind }]]));
        w.ThreeClickStack.show(input, { focus: 'designs', container: document.getElementById('map-container') }, {
          activate(_kind: string, _instance: unknown, body: HTMLElement) {
            const content = document.createElement('div');
            content.innerHTML = '<p>Building design details</p>'.repeat(40);
            body.appendChild(content);
          },
        });
      });
      const stack = page.locator('#three-click-stack');
      if (viewport.width < 768) {
        const handle = stack.locator(':scope > .mobile-dock-sheet-handle');
        await expect(handle).toBeVisible();
        const surface = await stack.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, handleHeight: el.firstElementChild!.getBoundingClientRect().height }));
        expect(surface.background).toMatch(/^rgba\(.+, 0\.8\)$/);
        expect(surface.handleHeight).toBeGreaterThanOrEqual(44);
        await handle.focus();
        await page.keyboard.press('End');
      }
      const expandedHeight = (await stack.boundingBox())!.height;
      await stack.locator('[data-action="row"][data-kind="designs"]').click();
      await expect(stack.locator('.click-stack__body')).toHaveCount(0);
      await expect.poll(async () => (await stack.boundingBox())!.height).toBeLessThan(expandedHeight - 100);
      const collapsedHeight = (await stack.boundingBox())!.height;
      await stack.locator('[data-action="row"][data-kind="designs"]').click();
      await expect.poll(async () => (await stack.boundingBox())!.height).toBeGreaterThan(collapsedHeight + 100);
      await expect(stack.locator('.click-stack__body')).toHaveCount(1);
    });
  });
}
