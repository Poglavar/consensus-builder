// Exercise the real stack DOM and styles without booting the 3D renderer or source APIs.
import { test, expect } from '@playwright/test';
import path from 'node:path';

const frontend = path.resolve(__dirname, '../../frontend');

for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 844 }]) {
  test.describe(`3D click stack sizing at ${viewport.width}px`, () => {
    test.use({ viewport });

    test.beforeEach(async ({ page }) => {
      await page.setContent('<!doctype html><html><body class="three-mode-active"><main id="map-container"></main></body></html>');
      for (const file of ['tokens', 'primitives', 'base', 'map', 'panels', 'utilities', 'map-shell', 'planning-views', 'mobile-sheets', 'three-click-stack', 'click-stack-navigation']) {
        await page.addStyleTag({ path: path.join(frontend, `css/${file}.css`) });
      }
      await page.addScriptTag({ path: path.join(frontend, 'js/click-stack/click-stack-model.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/mobile-dock-sheet.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/ui/object-list.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/click-stack/click-stack-relations.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/click-stack/click-stack-navigation.js') });
      await page.addScriptTag({ path: path.join(frontend, 'js/three-click-stack.js') });
      await page.evaluate(() => {
        const labels: Record<string, string> = {
          'clickStackNavigation.objects': 'Objects', 'clickStackNavigation.content': 'Content',
          'clickStackNavigation.info': 'Info', 'clickStackNavigation.actions': 'Actions',
          'clickStackNavigation.close': 'Close', 'clickStackNavigation.fullScreen': 'Full screen',
          'clickStackNavigation.showMap': 'Show map', 'clickStackNavigation.designs': 'Designs',
          'clickStackNavigation.plans': 'Plans', 'clickStackNavigation.parcels': 'Parcels',
          'clickStackNavigation.built': 'Built', 'clickStackNavigation.permitted': 'Permitted',
          'clickStackNavigation.formed': 'Formed parcels', 'clickStackNavigation.agreements': 'Agreements'
        };
        (window as any).i18n = { t: (key: string) => labels[key] || key };
      });
    });

    test('scoped agreement selector sits above Plans and follows the selected plan', async ({ page }) => {
      for (const file of ['design-memberships', 'ui/busy-control']) {
        await page.addScriptTag({ path: path.join(frontend, `js/${file}.js`) });
      }
      await page.evaluate(() => {
        const w = window as any;
        w.i18n = { t: (key: string) => ({ 'designMemberships.agreement': 'Agreement', 'designMemberships.openAgreement': 'Agreement details',
          'designMemberships.plan': 'Plan', 'clickStackRelations.chooseAgreement': 'Choose agreement', 'clickStackRelations.choosePlan': 'Choose plan' } as any)[key] || key };
        w.AgreementStore = { list: () => [{ id: 'a1', title: 'First terms', plan: { cid: 'p1' } },
          { id: 'a2', title: 'Alternative terms', plan: { cid: 'p1' } }, { id: 'a3', title: 'Other plan terms', plan: { cid: 'p2' } }] };
        w.NamedPlans = {}; w.AgreementPanel = { release() {}, async mount(host: HTMLElement, instance: any) {
          w.mountedAgreement = instance.id; const title = document.createElement('h4'); title.className = 'agreement-object-heading'; title.textContent = instance.label; host.appendChild(title);
        } };
        w.ThreeClickStack.show({ plans: ['p1', 'p2'].map(id => ({ id, cid: id, label: id, draft: true, content: { title: id, designCids: [] } })) },
          { focus: 'plans', container: document.getElementById('map-container') }, { activate() {}, focus() {} });
      });
      const root = page.locator('#three-click-stack'), agreements = root.locator('[data-kind="agreements"].click-stack__section');
      if (viewport.width < 768) {
        await expect(agreements).toBeHidden();
      }
      expect(await root.locator('.click-stack__section').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.kind))).toEqual(['agreements', 'plans']);
      await root.locator('.click-stack__selector[data-kind="plans"]').selectOption('p2');
      if (viewport.width < 768) await root.locator('.click-stack__object-tab[data-kind="agreements"]').click();
      else await agreements.locator('.click-stack__row').click();
      await expect(agreements).toBeVisible();
      await expect(agreements.locator('.agreement-object-heading')).toHaveText('Other plan terms');
      await expect(agreements.locator('.click-stack__selector')).toHaveCount(0);
      await expect(agreements.getByRole('button', { name: 'Agreement details', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => (window as any).mountedAgreement)).toBe('a3');
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
              panel.className = `sizing-content ${hosted ? 'planning-inspector is-hosted' : 'three-mode-parcel-panel'}`;
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
        if (scenario.kind === 'designs') await page.locator('#three-click-stack .click-stack__content-tabs [data-page="info"]').click();

        const metrics = await page.evaluate(() => {
          const stack = document.querySelector('#three-click-stack')!;
          const body = stack.querySelector('.click-stack__body')!;
          const content = body.querySelector('.sizing-content')!;
          return {
            stack: stack.getBoundingClientRect().toJSON(),
            body: body.getBoundingClientRect().toJSON(),
            content: content.getBoundingClientRect().toJSON(),
            bodyScrollHeight: body.scrollHeight,
            bodyClientHeight: body.clientHeight,
            bodyPadding: parseFloat(getComputedStyle(body).paddingTop) + parseFloat(getComputedStyle(body).paddingBottom),
            contentTabsHeight: body.querySelector('.click-stack__content-tabs')?.getBoundingClientRect().height || 0,
            bodyGap: parseFloat(getComputedStyle(body).rowGap),
            stackScrollHeight: stack.scrollHeight,
            stackClientHeight: stack.clientHeight,
            headings: [...stack.querySelectorAll('.click-stack__heading')].map(el => el.getBoundingClientRect().toJSON()),
            maxHeight: parseFloat(getComputedStyle(stack).maxHeight),
          };
        });
        expect(metrics.stack.height).toBeLessThanOrEqual(metrics.maxHeight + 1);
        const stack = page.locator('#three-click-stack');
        if (viewport.width < 768) {
          await expect(stack.locator('.mobile-dock-sheet-handle')).toHaveCount(0);
          await expect(stack.locator('.click-stack__object-tab')).toHaveCount(4);
          await expect(stack.locator('.click-stack__section:visible')).toHaveCount(1);
          await expect(stack.locator('.click-stack__content-tabs [data-page="info"]')).toBeVisible();
        }
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
        if (viewport.width >= 768) {
          for (const heading of metrics.headings) {
            expect(heading.height).toBeGreaterThanOrEqual(40);
            expect(heading.bottom).toBeLessThanOrEqual(metrics.stack.bottom + 1);
          }
        }
        if (scenario.paragraphs === 1) {
          expect(metrics.body.height - metrics.content.height).toBeLessThanOrEqual(metrics.bodyPadding + metrics.contentTabsHeight + metrics.bodyGap + 1);
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

    test('collapsing a section shrinks the panel; mobile uses object tabs and an explicit map/full-size control', async ({ page }) => {
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
        await expect(stack.locator('.mobile-dock-sheet-handle')).toHaveCount(0);
        const surface = await stack.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, objectTabsHeight: el.firstElementChild!.getBoundingClientRect().height }));
        expect(surface.background).toMatch(/^rgba\(.+, 0\.8\)$/);
        expect(surface.objectTabsHeight).toBeGreaterThanOrEqual(44);
        await expect(stack.locator('.click-stack__object-tab')).toHaveCount(4);
        await stack.locator('.click-stack__object-tab[data-kind="parcels"]').click();
        await expect(stack.locator('.click-stack__object-tab[data-kind="parcels"]')).toHaveAttribute('aria-selected', 'true');
        await expect(stack.locator('.click-stack__section:visible')).toHaveAttribute('data-kind', 'parcels');
        await stack.locator('.click-stack__object-tab[data-kind="designs"]').click();
        await stack.locator('.click-stack__size').click();
        await expect(stack).toHaveClass(/is-mobile-full/);
        await stack.locator('.click-stack__size').click();
        await expect(stack).not.toHaveClass(/is-mobile-full/);
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
