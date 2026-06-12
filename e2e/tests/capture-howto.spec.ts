// On-demand screenshot capture for the Croatian how-to guides (kako-koristiti*.html).
// Drives the real proposal-creation UI in Croatian, with mocked parcels, and writes PNGs
// straight into frontend/images/howto/ where the guide pages expect them.
//
// Not part of the normal suite — guarded by CAPTURE_HOWTO so it never flakes CI on tiles.
// Run with:  CAPTURE_HOWTO=1 npx playwright test capture-howto
//
// Each shot is wrapped so one failing state (e.g. a final "created" view that needs the
// full submit flow) just leaves its placeholder in place instead of aborting the rest.

import { test } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';
import * as path from 'path';
import * as fs from 'fs';

const OUT_DIR = path.resolve(__dirname, '../../frontend/images/howto');

// Three contiguous mocked parcels in KO 335754 "Trnje" (see helpers/mocks/parcel-data.ts).
const PARCEL_IDS = ['HR-335754-1234', 'HR-335754-1235', 'HR-335754-1236'];
const CENTER: [number, number] = [45.80025, 15.98305];

test.describe('Capture how-to screenshots', () => {
  test.skip(!process.env.CAPTURE_HOWTO, 'Set CAPTURE_HOWTO=1 to run the screenshot capture.');
  test.setTimeout(120_000);

  test('capture road/track and reparcellization flows', async ({ mockApi: page }) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const shot = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        console.log(`  ✓ ${name}.png`);
      } catch (e: any) {
        console.log(`  ✗ ${name}.png skipped — ${e?.message || e}`);
      }
    };
    const saveEl = async (selector: string, name: string) => {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: 8000 });
      await page.waitForTimeout(250);
      await el.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    };
    const saveView = async (name: string) =>
      page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });

    // ---- App in Croatian, parcels rendered, selection seeded ----
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/?city=zagreb');   // default city is new_york; Zagreb uses the mocked /parcels API
    await waitForMapReady(page);

    await page.evaluate(() => (window as any).i18n?.setLanguage?.('hr'));
    await page.waitForTimeout(300);

    await page.evaluate((c) => (window as any).map?.setView(c, 18), CENTER);
    // Wait until the Croatian mock parcels are actually rendered (not the NY defaults).
    await page.waitForFunction(() => {
      const w = window as any;
      return !!w.multiParcelSelection?.findParcelById?.('HR-335754-1234');
    }, { timeout: 15000 });
    await page.waitForTimeout(600);

    // Don't get blocked by the guest welcome gate.
    await page.evaluate(() => {
      try {
        const a = (window as any).getCurrentUserAgent?.();
        if (a) a.isGuest = false;
      } catch (_) { /* ignore */ }
    });

    const seedSelection = async () => {
      const count = await page.evaluate((ids) => {
        const m = (window as any).multiParcelSelection;
        if (!m) return -1;
        m.isActive = true;
        m.selectedParcels.clear();
        ids.forEach((id: string) => {
          m.selectedParcels.add(id);
          const layer = m.findParcelById?.(id);
          if (layer && typeof m.addParcelHighlight === 'function') m.addParcelHighlight(layer);
        });
        m.lastSelectedParcelId = ids[ids.length - 1];
        m.updateUI?.();
        return m.getSelectedParcels().length;
      }, PARCEL_IDS);
      if (count !== PARCEL_IDS.length) {
        const diag = await page.evaluate(() => {
          const w = window as any;
          const layers = w.parcelLayer?.getLayers?.() || [];
          const ids = layers.slice(0, 8).map((l: any) => {
            try {
              if (typeof w.getParcelIdFromFeature === 'function') return w.getParcelIdFromFeature(l.feature);
            } catch (_) {}
            return l?.feature?.properties?.parcelId || l?.feature?.properties?.id || '?';
          });
          return {
            hasMulti: !!w.multiParcelSelection,
            layerCount: layers.length,
            sampleIds: ids,
            findFirst: !!w.multiParcelSelection?.findParcelById?.('HR-335754-1234'),
            dataSource: w.currentDataSource || w.DataSource?.current || w.dataSourceMode || 'unknown',
          };
        });
        throw new Error(`selection seeded ${count}/${PARCEL_IDS.length}. diag=${JSON.stringify(diag)}`);
      }
    };
    await seedSelection();

    const closeModals = async () => {
      await page.evaluate(() => {
        document.querySelectorAll(
          '.create-proposal-modal, .constrained-corridor-overlay, .reparcel-modal-overlay, .cb-confirm-overlay'
        ).forEach((el) => el.remove());
      });
      await page.waitForTimeout(150);
    };

    // The "no wallet, proceed in-memory?" confirm pops up and intercepts clicks — accept it.
    const dismissConfirm = async () => {
      await page.evaluate(() => {
        const overlay = document.querySelector('.cb-confirm-overlay');
        if (!overlay) return;
        const proceed = overlay.querySelector('.cb-confirm-button') as HTMLButtonElement | null;
        if (proceed) proceed.click(); else overlay.remove();
      });
      await page.waitForTimeout(200);
    };

    // ===== Shared: map with the selection (used by both guides' step 1) =====
    await shot('cesta-01-odabir', async () => { await saveView('cesta-01-odabir'); });
    await shot('reparcelacija-01-odabir', async () => { await saveView('reparcelacija-01-odabir'); });

    // ===== ROAD / TRACK =====
    await shot('cesta-02-modal', async () => {
      await page.evaluate(() => (window as any).showProposalDialog());
      await saveEl('.create-proposal-modal', 'cesta-02-modal');
    });

    await shot('cesta-03-cilj', async () => {
      await dismissConfirm();
      await page.click('.create-proposal-modal .proposal-type-button[data-proposal-tool="road-track"]');
      await dismissConfirm();
      await page.waitForSelector('#proposalGeometryGroup', { state: 'visible', timeout: 6000 });
      await page.waitForTimeout(250);
      await saveEl('.create-proposal-modal', 'cesta-03-cilj');
    });

    // The mocked sample parcels have small gaps between them, so the real contiguity check
    // (areParcelsContiguous) reports 3 separate components and the corridor tool aborts.
    // For an illustrative screenshot that guard is irrelevant — force it to pass.
    await page.evaluate(() => { (window as any).areParcelsContiguous = () => ({ contiguous: true }); });

    await shot('cesta-05-koridor', async () => {
      // Open the corridor the real way: the "Uredi" geometry button (from the still-open modal).
      await dismissConfirm();
      await page.click('#proposalGeometryButtons button[data-geometry-action="edit"]');
      await dismissConfirm();
      await page.waitForSelector('.constrained-corridor-overlay', { state: 'visible', timeout: 8000 });
      await page.waitForTimeout(900);
      await saveEl('.constrained-corridor-overlay', 'cesta-05-koridor');
    });

    await shot('cesta-06-crtanje', async () => {
      // Switch the corridor to draw mode so the width picker shows.
      await page.click('.constrained-corridor-overlay [data-corridor-mode="draw"]');
      await page.waitForTimeout(400);
      await saveEl('.constrained-corridor-overlay', 'cesta-06-crtanje');
    });
    await closeModals();

    // NOTE: the "...-09-gotovo" (created proposal) shots are intentionally NOT captured here —
    // they need the full submit flow. The guide pages keep their "Snimka zaslona uskoro"
    // placeholders for those steps until someone captures a real created-proposal view.

    // ===== REPARCELLIZATION =====
    await seedSelection();

    await shot('reparcelacija-02-modal', async () => {
      await page.evaluate(() => (window as any).showProposalDialog());
      await saveEl('.create-proposal-modal', 'reparcelacija-02-modal');
    });

    await shot('reparcelacija-03-cilj', async () => {
      await dismissConfirm();
      await page.click('.create-proposal-modal .proposal-type-button[data-proposal-tool="reparcellization"]');
      await dismissConfirm();
      await page.waitForTimeout(400);
      await saveEl('.create-proposal-modal', 'reparcelacija-03-cilj');
    });
    await closeModals();

    await shot('reparcelacija-05-alat', async () => {
      await page.evaluate(async () => { await (window as any).openReparcellizationModal(); });
      await page.waitForSelector('.reparcel-modal-overlay', { state: 'visible', timeout: 10000 });
      await page.waitForTimeout(1200);
      await saveEl('.reparcel-modal-overlay', 'reparcelacija-05-alat');
    });
    await closeModals();
  });
});
