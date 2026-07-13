// On-demand screenshot capture for the how-to guides (kako-koristiti*.html / how-to-use*.html).
// Drives the REAL local app (docker stack: frontend :8080, backend :3000, postgres :5432) in
// Croatian against real Zagreb cadastre data — no mocks — and writes PNGs straight into
// frontend/images/howto/ where the guide pages expect them.
//
// Not part of the normal suite — guarded by CAPTURE_HOWTO so it never runs in CI.
// Run with:  cd e2e && CAPTURE_HOWTO=1 npx playwright test capture-howto
//
// Every shot is wrapped so one broken flow leaves its file untouched instead of aborting the rest.
// Nothing here fakes a screenshot: if a tool refuses to open, the shot is skipped and reported.

import { test } from '@playwright/test';
import { waitForMapReady } from '../helpers/app';
import * as path from 'path';
import * as fs from 'fs';

const OUT_DIR = path.resolve(__dirname, '../../frontend/images/howto');
const APP_URL = 'http://localhost:8080/?city=zagreb&lang=hr';
// A residential block in Trnje with well-formed real parcels.
const CENTER: [number, number] = [45.80025, 15.98305];

test.describe('Capture how-to screenshots', () => {
  test.skip(!process.env.CAPTURE_HOWTO, 'Set CAPTURE_HOWTO=1 to run the screenshot capture.');
  test.setTimeout(1_200_000);

  test('capture how-to guide screenshots against the real local app', async ({ page }) => {
    fs.mkdirSync(OUT_DIR, { recursive: true });

    const done: string[] = [];
    const skipped: string[] = [];

    const shot = async (name: string, fn: () => Promise<void>) => {
      try {
        await fn();
        if (!fs.existsSync(path.join(OUT_DIR, `${name}.png`))) throw new Error('no file written');
        done.push(name);
        console.log(`  ✓ ${name}`);
      } catch (e: any) {
        skipped.push(`${name} — ${e?.message || e}`);
        console.log(`  ✗ ${name} — ${(e?.message || e).toString().split('\n')[0]}`);
        console.log((e?.stack || '').split('\n').slice(0, 6).join('\n'));
      }
    };
    const saveEl = async (selector: string, name: string) => {
      const el = page.locator(selector).first();
      await el.waitFor({ state: 'visible', timeout: 10_000 });
      await page.waitForTimeout(500);
      await el.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    };
    // Every modal here is a full-screen overlay div wrapping a centred card; shooting the overlay
    // just reproduces the viewport. `wait` is the overlay (that's what appears), `card` is the
    // element actually worth cropping.
    const saveCard = async (overlay: string, card: string, name: string) => {
      await page.locator(overlay).first().waitFor({ state: 'visible', timeout: 15_000 });
      await saveEl(card, name);
    };
    const saveView = async (name: string) => {
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    };

    page.on('pageerror', (err) => console.log(`  [pageerror] ${err.message}`));

    // ---------------------------------------------------------------- setup
    await page.setViewportSize({ width: 1456, height: 902 });
    await page.goto(APP_URL);
    await waitForMapReady(page);

    // Proposals persist in IndexedDB — start every capture run from an empty city, or leftovers
    // from a previous run (or a previous session) show up on the map in the shots.
    await page.evaluate(async () => {
      await (window as any).wipeAllLocalData?.({ skipReload: true });
    });
    await page.goto(APP_URL);
    await waitForMapReady(page);
    await page.waitForFunction(
      () => ((window as any).parcelLayer?.getLayers?.() || []).length > 0,
      undefined,
      { timeout: 30_000 }
    );

    // Dev chrome off, guest gate off — this is what makes the shots publishable.
    const cleanChrome = async () => {
      await page.evaluate(() => {
        const w = window as any;
        document.querySelector('.cb-multitab-banner')?.remove();
        document.body.classList.remove('debug-mode');
        w.updateBadgeVisibility?.();
        const u = document.getElementById('username-display');
        if (u) (u as HTMLElement).style.display = 'none';
        const welcome = document.getElementById('welcome-modal');
        if (welcome) (welcome as HTMLElement).style.display = 'none';
        try {
          const agent = w.getCurrentUserAgent?.();
          if (agent) agent.isGuest = false;
        } catch (_) { /* ignore */ }
      });
    };
    await cleanChrome();

    const centreOnParcels = async (c: [number, number], zoom = 18) => {
      await page.evaluate(([latlng, z]: any) => (window as any).map.setView(latlng, z), [c, zoom] as any);
      await page.waitForTimeout(1500);
      await page.waitForFunction(
        () => ((window as any).parcelLayer?.getLayers?.() || []).length > 5,
        undefined,
        { timeout: 30_000 }
      );
      await page.waitForTimeout(1000);
    };
    await centreOnParcels(CENTER);

    // Full reset back to an empty city. Used after a flow that CREATES an object (finishing a road
    // is an instant apply — see cesta-04) so the object doesn't ride along into later shots.
    const resetApp = async () => {
      await page.evaluate(async () => {
        await (window as any).wipeAllLocalData?.({ skipReload: true });
      });
      await page.goto(APP_URL);
      await waitForMapReady(page);
      await page.waitForFunction(
        () => ((window as any).parcelLayer?.getLayers?.() || []).length > 0,
        undefined,
        { timeout: 30_000 }
      );
      await cleanChrome();
      await centreOnParcels(CENTER);
    };

    // A styled confirm ("did you mean the whole block?", "proceed without a wallet?") swallows
    // clicks; accept it whenever one shows up.
    const acceptConfirm = async () => {
      await page.evaluate(() => {
        const overlay = document.querySelector('.cb-confirm-overlay');
        if (!overlay) return;
        const ok = overlay.querySelector('.cb-confirm-button, .cb-confirm-ok, button');
        if (ok) (ok as HTMLButtonElement).click();
        else overlay.remove();
      });
      await page.waitForTimeout(300);
    };

    // Close whatever design tool / dialog is open — as a CANCEL, not a save. Closing a building
    // editor now discards (the X asks first), so dropping the active draft up front means there is
    // nothing left to confirm and the close runs straight through. A shot that wants the design
    // APPLIED must press the tool's Done button (#btn-blockify-done) instead of calling this.
    const closeTools = async () => {
      await page.evaluate(() => {
        const w = window as any;
        try {
          const draft = w.getActiveProposalDesignDraft?.();
          if (draft) w.proposalDraftStore?.deleteDraft?.(draft.id);
        } catch (_) { }
        const click = (sel: string) => {
          const el = document.querySelector(sel) as HTMLElement | null;
          if (el && el.offsetParent !== null) { el.click(); return true; }
          return false;
        };
        click('.corridor-editor-cancel');
        click('#blockify-close');
        click('#rowhouse-close');
        click('#single-building-close');
        click('#parcelbased-close');
        click('.reparcel-close-btn');
        try { w.closeStructureGeometryEditor?.(); } catch (_) { }
        try { w.closeProposalDialog?.(); } catch (_) { }
        document.querySelectorAll('.constrained-corridor-overlay').forEach(el => el.remove());
      });
      await page.waitForTimeout(600);
      // Closing a design tool now asks "Discard this design? / Keep editing" (the Done button is
      // the only commit path). The dialog's FIRST button is "Keep editing", so the generic
      // acceptConfirm above would leave the tool open and it would photobomb the next shot —
      // answer this one on its primary (Discard/Odbaci) button instead.
      for (let i = 0; i < 3; i++) {
        const handled = await page.evaluate(() => {
          const overlay = document.querySelector('.cb-confirm-overlay');
          if (!overlay) return false;
          const message = overlay.querySelector('.cb-confirm-message')?.textContent || '';
          if (!/dizajn|design/i.test(message)) return false;
          const discard = (overlay.querySelector('.btn-action') || overlay.querySelector('button:last-of-type')) as HTMLButtonElement | null;
          if (!discard) return false;
          discard.click();
          return true;
        });
        if (!handled) break;
        await page.waitForTimeout(500);
      }
      await acceptConfirm();
      // Any proposal card the tool left selected/open must not ride along into the next shot.
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
        try { w.clearProposalHighlights?.(); } catch (_) { }
        try { w.ProposalSelection?.clear?.(); } catch (_) { }
      });
      await page.waitForTimeout(300);
    };

    // ------------------------------------------------- parcel picking helpers
    // Contiguous run of real parcels near the map centre, grown with turf on ~0.6 m buffers
    // (block/row/lake/corridor tools refuse a non-contiguous selection).
    const pickContiguous = async (count: number): Promise<string[]> => {
      return page.evaluate((n) => {
        const w = window as any;
        const turf = w.turf;
        const center = w.map.getCenter();
        const layers = (w.parcelLayer?.getLayers?.() || []).filter((l: any) => l?.feature?.geometry);
        const info: any[] = [];
        for (const layer of layers) {
          const f = layer.feature;
          let id: string | null = null;
          try { id = w.getParcelIdFromFeature ? String(w.getParcelIdFromFeature(f)) : null; } catch (_) { id = null; }
          if (!id || id === 'null' || id === 'undefined') continue;
          let area = 0;
          let c: number[] | null = null;
          try { area = turf.area(f); c = turf.centroid(f).geometry.coordinates; } catch (_) { continue; }
          if (!(area >= 400 && area <= 4000) || !c) continue;
          const dist = Math.hypot(c[0] - center.lng, c[1] - center.lat);
          info.push({ id, f, layer, area, dist });
        }
        info.sort((a, b) => a.dist - b.dist);
        const pool = info.slice(0, 50);
        if (!pool.length) return [];
        const bufs = new Map<string, any>();
        const bufOf = (x: any) => {
          if (!bufs.has(x.id)) bufs.set(x.id, turf.buffer(x.f, 0.6, { units: 'meters' }));
          return bufs.get(x.id);
        };
        const touches = (a: any, b: any) => {
          try { return turf.booleanIntersects(bufOf(a), bufOf(b)); } catch (_) { return false; }
        };
        const chosen = [pool[0]];
        while (chosen.length < n) {
          let next: any = null;
          for (const cand of pool) {
            if (chosen.some(c2 => c2.id === cand.id)) continue;
            if (chosen.some(c2 => touches(c2, cand))) { next = cand; break; }
          }
          if (!next) break;
          chosen.push(next);
        }
        return chosen.map(x => x.id);
      }, count);
    };

    // The app's own contiguity verdict on a set of ids (the same guard the tools use).
    const isContiguous = async (ids: string[]): Promise<boolean> => {
      return page.evaluate((list) => {
        const w = window as any;
        if (typeof w.areParcelsContiguous !== 'function') return true;
        const layers = list
          .map((id: string) => w.multiParcelSelection?.findParcelById?.(id))
          .filter(Boolean);
        if (layers.length !== list.length) return false;
        try { return !!w.areParcelsContiguous(layers).contiguous; } catch (_) { return false; }
      }, ids);
    };

    // Synthetic map clicks don't hit Leaflet's SVG paths — call the app's handler directly.
    const selectParcel = async (id: string) => {
      await page.evaluate((pid) => {
        const w = window as any;
        const layer = w.parcelLayer.getLayers().find((l: any) => {
          try { return String(w.getParcelIdFromFeature(l.feature)) === pid; } catch (_) { return false; }
        });
        if (!layer) throw new Error(`parcel ${pid} not on the map`);
        w.onParcelClick({ target: layer, latlng: layer.getBounds().getCenter() });
      }, id);
      await page.waitForTimeout(600);
    };

    const seedMultiSelection = async (ids: string[]) => {
      const n = await page.evaluate((list) => {
        const w = window as any;
        const m = w.multiParcelSelection;
        if (!m) return -1;
        m.isActive = true;
        m.selectedParcels.clear();
        list.forEach((id: string) => {
          m.selectedParcels.add(id);
          const layer = m.findParcelById?.(id);
          if (layer && typeof m.addParcelHighlight === 'function') m.addParcelHighlight(layer);
        });
        m.lastSelectedParcelId = list[list.length - 1];
        m.updateUI?.();
        w.renderParcelProposalActions?.(list[0]);
        return m.selectedParcels.size;
      }, ids);
      if (n !== ids.length) throw new Error(`multi-selection seeded ${n}/${ids.length}`);
      await page.waitForTimeout(400);
    };

    const clearMultiSelection = async () => {
      await page.evaluate(() => {
        const w = window as any;
        const m = w.multiParcelSelection;
        if (!m) return;
        try { m.clearSelection?.(); } catch (_) { }
        m.isActive = false;
        m.selectedParcels?.clear?.();
      });
      await page.waitForTimeout(300);
    };

    // The key gains a "WithCount" suffix once the parcel carries proposals — match the prefix.
    const openProposalsTab = async () => {
      await page.evaluate(() => {
        const btn = document.querySelector('.parcel-tab-btn[data-i18n-key^="panel.parcel.tabProposals"]');
        if (!btn) throw new Error('Proposals tab button not found');
        (btn as HTMLElement).click();
      });
      await page.waitForTimeout(500);
    };

    // Panel + selection freshly re-established (design tools hide the panel when they open).
    const showPanelWithSelection = async (ids: string[]) => {
      await selectParcel(ids[0]);
      if (ids.length > 1) await seedMultiSelection(ids);
      await openProposalsTab();
    };

    const launchTool = async (key: string) => {
      await page.evaluate((k) => (window as any).startParcelBuildTool(k), key);
      await page.waitForTimeout(800);
      await acceptConfirm();
    };

    // ------------------------------------------------------- pick the parcels
    const blockIds = await pickContiguous(6);
    if (blockIds.length < 2) throw new Error(`could not find contiguous parcels near ${CENTER} (got ${blockIds.length})`);
    console.log(`  parcels: ${blockIds.join(', ')} (contiguous=${await (async () => {
      await seedMultiSelection(blockIds);
      const ok = await isContiguous(blockIds);
      await clearMultiSelection();
      return ok;
    })()})`);
    const primaryId = blockIds[0];

    // ======================================================== HUB / ODABIR
    await shot('hub-01-odabir', async () => {
      await showPanelWithSelection([primaryId]);
      await saveView('hub-01-odabir');
    });

    // =================================================== ROAD TOOL BUTTONS
    await shot('cesta-01-alati', async () => {
      await showPanelWithSelection([primaryId]);
      await saveEl('#parcel-info-panel', 'cesta-01-alati');
    });

    // ========================================================= BUILDINGS
    await shot('zgrade-01-blok', async () => {
      await showPanelWithSelection(blockIds);
      await launchTool('buildings');
      await saveCard('#blockify-modal', '#blockify-container', 'zgrade-01-blok');
    });

    // The same open blockify editor, seen over the map (hub step 2: "design").
    await shot('hub-02-dizajn', async () => {
      const open = await page.locator('#blockify-modal').isVisible().catch(() => false);
      if (!open) {
        await showPanelWithSelection(blockIds);
        await launchTool('buildings');
        await page.locator('#blockify-modal').waitFor({ state: 'visible', timeout: 10_000 });
      }
      await saveView('hub-02-dizajn');
    });
    await closeTools();

    await shot('zgrade-02-niz', async () => {
      await showPanelWithSelection(blockIds);
      await launchTool('row');
      await saveCard('#rowhouse-modal', '#rowhouse-container', 'zgrade-02-niz');
    });
    await closeTools();

    await shot('zgrade-03-slobodna-forma', async () => {
      await showPanelWithSelection(blockIds);
      await launchTool('single');
      await saveCard('#single-building-modal', '#single-building-container', 'zgrade-03-slobodna-forma');
    });
    await closeTools();

    // ==================================================== CREATE PROPOSAL
    await shot('hub-03-uvjeti', async () => {
      await showPanelWithSelection(blockIds);
      await page.evaluate(() => (window as any).showProposalDialog());
      await saveCard('.create-proposal-modal', '.create-proposal-modal .proposal-modal-content', 'hub-03-uvjeti');
    });
    await closeTools();

    // ==================================================== REPARCELLIZATION
    await shot('reparcelacija-01-odabir', async () => {
      await showPanelWithSelection(blockIds);
      await saveView('reparcelacija-01-odabir');
    });

    await shot('reparcelacija-02-alat', async () => {
      await showPanelWithSelection(blockIds);
      await launchTool('reparcellization');
      await page.locator('.reparcel-modal-overlay').waitFor({ state: 'visible', timeout: 20_000 });
      await page.waitForTimeout(2500); // the plan renders asynchronously
      await saveEl('.reparcel-modal', 'reparcelacija-02-alat');
    });
    await closeTools();

    // ============================================ ROAD DESIGNATION (cesta-05)
    // Not a corridor: the merged parcels simply BECOME road land, with nothing designed. (The
    // overlay keeps its old .constrained-corridor-* class names — the tool was renamed, the CSS
    // was not.)
    await shot('cesta-05-koridor', async () => {
      await showPanelWithSelection(blockIds);
      await page.evaluate(() => (window as any).openRoadDesignationModal());
      await page.locator('.constrained-corridor-overlay').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1500);
      await saveEl('.constrained-corridor-modal', 'cesta-05-koridor');
    });
    await closeTools();
    await clearMultiSelection();

    // The corridor/obstacle machinery keeps module-level state (corridor-tunnel's `promptActive`
    // guard among it), and the design tools opened above leave enough of it behind that a later
    // "Finish road" can bail out silently — the drawing just stays open and no object is created.
    // A reload is the cheap, honest reset; the road flow below then runs against a clean page.
    await resetApp();

    // ================================================== ROAD DRAWING (cesta-02/03)
    await shot('cesta-02-crtanje', async () => {
      await page.evaluate(() => (window as any).map.setView([45.80025, 15.98305], 18));
      await page.waitForTimeout(800);
      await page.evaluate(async () => { await (window as any).requestRoadDrawTool(); });
      await page.waitForTimeout(1500);
      await acceptConfirm();
      await page.waitForSelector('#road-info-panel.visible', { timeout: 10_000 });

      // Three real map clicks along a line through the block — road drawing listens on the map.
      const box = await page.locator('.leaflet-container').boundingBox();
      if (!box) throw new Error('no map container');
      const pts = [
        { x: box.x + box.width * 0.35, y: box.y + box.height * 0.68 },
        { x: box.x + box.width * 0.50, y: box.y + box.height * 0.48 },
        { x: box.x + box.width * 0.66, y: box.y + box.height * 0.35 },
      ];
      for (const p of pts) {
        await page.mouse.click(p.x, p.y);
        await page.waitForTimeout(900);
        await acceptConfirm();
      }
      // Park the cursor away from the rubber-band line so the shot shows the placed road.
      await page.mouse.move(box.x + box.width * 0.66, box.y + box.height * 0.34);
      await page.waitForTimeout(600);

      const drawn = await page.evaluate(() => {
        const w = window as any;
        const segs = typeof w.getAllRoadSegments === 'function' ? w.getAllRoadSegments(true) : [];
        return { mode: !!w.roadDrawingMode, segments: segs.length };
      });
      if (!drawn.mode) throw new Error('road drawing mode is not active');
      if (!drawn.segments) throw new Error('no road segment was drawn by the map clicks');

      // The panel's readouts ARE this figure, so the shot is only honest if the SHIPPED panel shows
      // them all: it sizes to its content, so nothing here touches its styling. Assert that — a
      // regression that clips Cijena/TEAD again must fail the capture, not be papered over by it.
      const panel = await page.evaluate(() => {
        const el = document.getElementById('road-info-panel') as HTMLElement | null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: r.top, left: r.left, clipped: el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight };
      });
      if (!panel) throw new Error('road panel not in the DOM');
      if (panel.top < 0 || panel.left < 0) throw new Error('road panel does not fit the viewport');
      if (panel.clipped) throw new Error('road panel clips its content');
      await page.waitForTimeout(400);
      await saveView('cesta-02-crtanje');
    });

    await shot('cesta-03-presjek', async () => {
      const drawing = await page.evaluate(() => !!(window as any).roadDrawingMode);
      if (!drawing) throw new Error('road drawing not active (cesta-02 flow failed)');
      await page.evaluate(() => (window as any).openRoadDrawingCrossSectionEditor());
      await page.waitForTimeout(1000);
      await saveCard('#corridor-editor-overlay', '#corridor-editor-overlay .corridor-editor', 'cesta-03-presjek');
    });
    // Leave the cross-section editor but KEEP the drawing — cesta-04 finishes it.
    await page.evaluate(() => {
      (document.querySelector('.corridor-editor-cancel') as HTMLElement | null)?.click();
    });
    await page.waitForTimeout(1000);
    await acceptConfirm();

    // ============================================ FINISHED ROAD PROPOSAL (cesta-04)
    // "Finish road (F)" IS the creation — the drawing instantly becomes an applied road object.
    // Buildings in the way raise a styled choice (cut / demolish / tunnel); acceptConfirm takes
    // the primary option ("cut through the buildings"), which is the app's own default.
    await shot('cesta-04-prijedlog', async () => {
      const drawing = await page.evaluate(() => !!(window as any).roadDrawingMode);
      if (!drawing) throw new Error('road drawing not active (cesta-02 flow failed)');
      await page.click('#finishRoadButton');

      // The finish is async (footprint preload → obstacle prompt → apply); poll while answering.
      let roadProposalId: string | null = null;
      for (let i = 0; i < 25 && !roadProposalId; i++) {
        await acceptConfirm();
        roadProposalId = await page.evaluate(() => {
          const w = window as any;
          const all = w.proposalStorage?.getAllProposals?.() || [];
          const roads = all.filter((p: any) =>
            p?.roadProposal || p?.adapterKey === 'road' || p?.goal === 'road-track' || p?.goal === 'road');
          if (!roads.length) return null;
          const p = roads[roads.length - 1];
          return String(p.proposalId || p.id);
        });
        if (!roadProposalId) await page.waitForTimeout(800);
      }
      if (!roadProposalId) {
        const state = await page.evaluate(() => {
          const w = window as any;
          const all = w.proposalStorage?.getAllProposals?.() || [];
          return {
            drawing: !!w.roadDrawingMode,
            segments: (w.getAllRoadSegments?.(true) || []).length,
            proposals: all.map((p: any) => p.goal || p.adapterKey || '?'),
            confirmOpen: !!document.querySelector('.cb-confirm-overlay'),
            dialogOpen: !!document.querySelector('.create-proposal-modal'),
          };
        });
        throw new Error(`finishing the drawing created no road proposal — ${JSON.stringify(state)}`);
      }
      await page.evaluate(() => (window as any).closeProposalDialog?.());

      // The created road, selected, with its details panel — the payoff of the roads guide.
      await page.evaluate((id) => {
        const w = window as any;
        if (typeof w.openProposalFromList !== 'function') throw new Error('openProposalFromList missing');
        w.openProposalFromList(id);
      }, roadProposalId);
      await page.locator('#proposal-details-panel.visible').waitFor({ state: 'visible', timeout: 15_000 });
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        // The panel opens collapsed for a freshly built object — the guide's step is about what's
        // IN it (Predloži, Uredi poprečni presjek, …), so show it open.
        try { w.toggleProposalDetailsPanelMinimized?.(false); } catch (_) { }
      });
      await cleanChrome();
      await page.waitForTimeout(1200);
      await saveView('cesta-04-prijedlog');
    });

    // The road is an applied object now — wipe it (and its parcel cuts) before the park shots.
    await closeTools();
    await resetApp();

    // ================================================================= PARK
    let parkProposalId: string | null = null;
    await shot('park-01-primijenjen', async () => {
      await showPanelWithSelection(blockIds);
      await launchTool('park');
      await page.waitForTimeout(3000);
      await acceptConfirm();
      parkProposalId = await page.waitForFunction(() => {
        const w = window as any;
        const all = w.proposalStorage?.getAllProposals?.() || [];
        const park = all.filter((p: any) =>
          p?.structureProposal?.kind === 'park' || p?.adapterKey === 'park' || p?.goal === 'park');
        if (!park.length) return null;
        const p = park[park.length - 1];
        return String(p.proposalId || p.id);
      }, undefined, { timeout: 20_000 }).then(h => h.jsonValue() as Promise<string>);
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
      });
      await page.waitForTimeout(1200);
      await saveView('park-01-primijenjen');
    });

    await shot('park-02-editor', async () => {
      if (!parkProposalId) throw new Error('no applied park proposal (park-01 flow failed)');
      await page.evaluate(async (id) => {
        const w = window as any;
        const opened = await w.editProposalGeometry(id);
        if (opened === false) throw new Error('editProposalGeometry returned false');
      }, parkProposalId);
      await page.locator('.structure-geometry-editor').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1500);
      await saveView('park-02-editor');
    });
    await page.evaluate(() => (window as any).closeStructureGeometryEditor?.());
    await page.waitForTimeout(800);
    await closeTools();

    // ================================================================== 3D
    await shot('prikazi-01-3d', async () => {
      await clearMultiSelection();
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
      });
      await page.click('#mode-3d-toggle');
      await page.waitForFunction(() => !!(window as any).isThreeModeActive?.(), undefined, { timeout: 60_000 });
      // 3D streams buildings — wait for the loading overlay to go and the scene to settle.
      await page.waitForTimeout(12_000);
      await page.waitForFunction(() => {
        const el = document.querySelector('.three-loading, .three-mode-loading, #three-loading') as HTMLElement | null;
        return !el || el.offsetParent === null;
      }, undefined, { timeout: 60_000 }).catch(() => { /* no overlay in this build */ });
      await cleanChrome();
      await saveView('prikazi-01-3d');
    });

    await shot('prikazi-02-panel', async () => {
      const active = await page.evaluate(() => !!(window as any).isThreeModeActive?.());
      if (!active) throw new Error('3D mode is not active');
      const canvas = await page.locator('canvas').first().boundingBox();
      if (!canvas) throw new Error('no 3D canvas');
      // Raycast-pick a parcel: try a few points until the info panel appears.
      const offsets = [[0.5, 0.55], [0.45, 0.6], [0.55, 0.5], [0.5, 0.65], [0.4, 0.5]];
      let visible = false;
      for (const [fx, fy] of offsets) {
        await page.mouse.click(canvas.x + canvas.width * fx, canvas.y + canvas.height * fy);
        await page.waitForTimeout(1200);
        visible = await page.locator('.three-mode-parcel-panel').isVisible().catch(() => false);
        if (visible) break;
        // A second click on the same subject clears the isolation — reset before the next try.
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
      if (!visible) throw new Error('3D parcel panel never appeared (raycast hit nothing)');
      await saveEl('.three-mode-parcel-panel', 'prikazi-02-panel');
    });

    // 3D frames itself from the Leaflet view it was entered from, so re-framing means going back
    // to 2D, centring where you want, and entering 3D again.
    const leave3D = async () => {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
      });
      const in3d = await page.evaluate(() => !!(window as any).isThreeModeActive?.());
      if (!in3d) return;
      await page.click('#mode-2d-toggle');
      await page.waitForFunction(() => !(window as any).isThreeModeActive?.(), undefined, { timeout: 30_000 });
      await page.waitForTimeout(1500);
    };
    const enter3D = async () => {
      await page.click('#mode-3d-toggle');
      await page.waitForFunction(() => !!(window as any).isThreeModeActive?.(), undefined, { timeout: 60_000 });
      await page.waitForTimeout(12_000);
      await page.waitForFunction(() => {
        const el = document.querySelector('.three-loading, .three-mode-loading, #three-loading') as HTMLElement | null;
        return !el || el.offsetParent === null;
      }, undefined, { timeout: 60_000 }).catch(() => { /* no overlay in this build */ });
      await cleanChrome();
    };

    // ============================================== PARK FURNITURE IN 3D (park-03)
    // The figure is "park with furniture in 3D", and a freshly applied park only carries the few
    // items the tool scatters itself — so furnish it first, exactly the way a user does: reopen
    // the geometry editor (the park-02 tool), place trees / benches / a pond / a footpath inside
    // the boundary, save. Then look at it from close range, deliberately tighter than
    // prikazi-01-3d's wide city view.
    await shot('park-03-3d', async () => {
      if (!parkProposalId) throw new Error('no applied park proposal (park-01 flow failed)');
      await leave3D();
      const plan = await page.evaluate((id) => {
        const w = window as any;
        const turf = w.turf;
        const geom = w.proposalStorage?.getProposal?.(id)?.structureProposal?.geometry;
        if (!geom || !turf) return null;
        const poly = { type: 'Feature', geometry: geom, properties: {} };
        const c = turf.centroid(poly).geometry.coordinates;
        const metresPerDegLng = 111320 * Math.cos(c[1] * Math.PI / 180);
        const offset = (dx: number, dy: number) => [c[0] + dx / metresPerDegLng, c[1] + dy / 111320];
        const grid: number[][] = [];
        for (let dx = -32; dx <= 32; dx += 8) {
          for (let dy = -15; dy <= 15; dy += 5) {
            const p = offset(dx, dy);
            try { if (turf.booleanPointInPolygon(p, poly)) grid.push(p); } catch (_) { /* skip */ }
          }
        }
        return { centre: { lng: c[0], lat: c[1] }, grid };
      }, parkProposalId);
      if (!plan || plan.grid.length < 10) throw new Error('no room inside the park to place furniture');

      // Furnish at zoom 19 — every placement is a real click on the map, so the spot has to be
      // on screen and clear of the editor panel.
      await page.evaluate((c: any) => (window as any).map.setView([c.lat, c.lng], 19), plan.centre);
      await page.waitForTimeout(1200);
      await page.evaluate(async (id) => {
        const opened = await (window as any).editProposalGeometry(id);
        if (opened === false) throw new Error('editProposalGeometry returned false');
      }, parkProposalId);
      await page.locator('.structure-geometry-editor').waitFor({ state: 'visible', timeout: 15_000 });
      await page.waitForTimeout(1500);

      const mapBox = await page.locator('.leaflet-container').boundingBox();
      const panelBox = await page.locator('.structure-geometry-editor').boundingBox();
      if (!mapBox || !panelBox) throw new Error('editor did not lay out');
      // Only spots that are actually clickable count: on screen, clear of the editor panel and of
      // the top-left map controls. Filtering up front keeps the item lists below deterministic.
      const screenPts = await page.evaluate((coords: number[][]) => coords.map((c) => {
        const p = (window as any).map.latLngToContainerPoint([c[1], c[0]]);
        return { x: p.x, y: p.y };
      }), plan.grid);
      const spots = plan.grid.filter((_, i) => {
        const x = mapBox.x + screenPts[i].x, y = mapBox.y + screenPts[i].y;
        const onPanel = x >= panelBox.x - 12 && x <= panelBox.x + panelBox.width + 12
          && y >= panelBox.y - 12 && y <= panelBox.y + panelBox.height + 12;
        return !onPanel
          && x > mapBox.x + 60 && x < mapBox.x + mapBox.width - 20
          && y > mapBox.y + 60 && y < mapBox.y + mapBox.height - 20;
      });
      if (spots.length < 10) throw new Error(`only ${spots.length} clickable spots inside the park`);

      const placeAt = async (coord: number[]) => {
        const pt = await page.evaluate((c: number[]) => {
          const p = (window as any).map.latLngToContainerPoint([c[1], c[0]]);
          return { x: p.x, y: p.y };
        }, coord);
        await page.mouse.click(mapBox.x + pt.x, mapBox.y + pt.y);
        await page.waitForTimeout(180);
      };
      const pickTool = async (tool: string) => {
        await page.click(`.structure-geometry-editor [data-tool="${tool}"]`);
        await page.waitForTimeout(200);
      };

      const g = spots;
      const mid = Math.floor(g.length / 2);
      await pickTool('tree');
      for (const c of [g[0], g[2], g[4], g[6], g[8], g[10], g[g.length - 1], g[g.length - 3], g[g.length - 5]]) if (c) await placeAt(c);
      await pickTool('bench');
      for (const c of [g[mid], g[mid + 2], g[mid - 2], g[mid + 4]]) if (c) await placeAt(c);
      await pickTool('pond');
      if (g[mid + 5]) await placeAt(g[mid + 5]);
      await pickTool('flowerbed');
      if (g[mid - 5]) await placeAt(g[mid - 5]);
      await pickTool('path');
      for (const c of [g[1], g[mid + 1], g[g.length - 2]]) if (c) await placeAt(c);
      const finishPath = page.locator('.structure-geometry-editor [data-action="finish-path"]');
      if (await finishPath.isEnabled()) await finishPath.click();
      await page.waitForTimeout(400);
      await page.click('.structure-geometry-editor [data-action="save"]');
      await page.waitForTimeout(2500);
      await acceptConfirm();
      await page.waitForTimeout(1500);

      // The saved design is what 3D reads (window.parks carries the decorations) — if nothing
      // landed, say so instead of shooting an empty lawn.
      const counts = await page.evaluate(() => {
        const w = window as any;
        const d = ((w.parks || [])[0]?.properties?.decorations) || {};
        return {
          trees: (d.trees || []).length,
          benches: (d.benches || []).length,
          ponds: (d.ponds || []).length,
          paths: (d.paths || []).length,
        };
      });
      console.log(`  park furniture: ${JSON.stringify(counts)}`);
      if (counts.trees < 5 || counts.benches < 1) throw new Error(`furniture did not stick: ${JSON.stringify(counts)}`);

      await page.evaluate((c: any) => (window as any).map.setView([c.lat, c.lng], 20), plan.centre);
      await page.waitForTimeout(1500);
      await enter3D();
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
      });
      // Entering 3D from zoom 20 still opens a block-wide view; dolly the orbit camera in on the
      // park so the benches / trees / pond / paths are actually readable.
      const canvas = await page.locator('canvas').first().boundingBox();
      if (!canvas) throw new Error('no 3D canvas');
      await page.mouse.move(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
      for (let i = 0; i < 12; i++) {
        await page.mouse.wheel(0, -240);
        await page.waitForTimeout(400);
      }
      await page.waitForTimeout(3000);
      await saveView('park-03-3d');
    });

    // ============================================ REALISTIC / PHOTOREAL (prikazi-03)
    // Google Photorealistic 3D Tiles via Cesium ion (token is baked into photoreal-mode.js).
    // A photoreal shot of bare city is pointless — the figure is about seeing YOUR proposal on the
    // real mesh — so a block of proposed buildings is applied first, on parcels away from the park.
    await shot('prikazi-03-realisticno', async () => {
      await leave3D();
      await clearMultiSelection();

      // Reload before the photoreal entry. Cesium opens on whatever vantage the abstract-3D camera
      // is sitting at (getEntryView → getThree3DGeoView), and park-03 left that camera dollied down
      // to street level — from there Google's mesh streams forever and never settles. A reload
      // hands 3D a fresh camera; the proposals live in IndexedDB and survive it.
      await page.goto(APP_URL);
      await waitForMapReady(page);
      await page.waitForFunction(
        () => ((window as any).parcelLayer?.getLayers?.() || []).length > 0,
        undefined,
        { timeout: 30_000 }
      );
      await cleanChrome();

      // Fresh contiguous parcels one block south of the park.
      await centreOnParcels([CENTER[0] - 0.0022, CENTER[1]] as [number, number]);
      const buildIds = await pickContiguous(6);
      if (buildIds.length < 2) throw new Error('no contiguous parcels for the building proposal');
      await showPanelWithSelection(buildIds);
      await launchTool('buildings');
      await page.locator('#blockify-modal').waitFor({ state: 'visible', timeout: 20_000 });
      // "Gotovo" stays disabled until the massing has actually been generated — waiting on it is
      // what keeps this from applying an empty design (and it is the button a user presses).
      await page.waitForFunction(
        () => {
          const b = document.getElementById('btn-blockify-done') as HTMLButtonElement | null;
          return !!b && !b.disabled;
        },
        undefined,
        { timeout: 60_000 }
      );
      await page.click('#btn-blockify-done');
      await page.waitForTimeout(2000);
      await acceptConfirm();
      await page.waitForFunction(
        () => ((window as any).proposedBuildings || []).length > 0,
        undefined,
        { timeout: 60_000 }
      );
      await page.evaluate(() => {
        const w = window as any;
        try { w.hideParcelInfoPanel?.(); } catch (_) { }
        try { w.hideProposalDetailsPanel?.(true); } catch (_) { }
      });
      await clearMultiSelection();
      await page.waitForTimeout(500);

      await page.click('#mode-realistic-toggle');
      await page.waitForFunction(() => !!(window as any).PhotorealMode?.isActive?.(), undefined, { timeout: 120_000 });
      // Google's tiles stream by view. The tileset's own `tilesLoaded` flag is the honest "this
      // view is fully resolved" signal — shooting earlier gives a half-melted mesh. Poll it (~25 s
      // on a warm CDN) and report what it was doing if it never settles.
      const tileState = async () => page.evaluate(() => {
        const w = window as any;
        const viewer = w.PhotorealMode?.getViewer?.();
        let loaded = false, pending = -1, processing = -1;
        if (viewer) {
          const prims = viewer.scene.primitives;
          for (let i = 0; i < prims.length; i++) {
            const p = prims.get(i);
            if (p && typeof p.tilesLoaded === 'boolean') {
              loaded = p.tilesLoaded;
              if (p.statistics) {
                pending = p.statistics.numberOfPendingRequests;
                processing = p.statistics.numberOfTilesProcessing;
              }
            }
          }
        }
        const chip = document.querySelector('.photoreal-tile-loader');
        return { loaded, pending, processing, chip: !!chip && chip.classList.contains('visible') };
      });
      let settled = 0;
      let last: any = null;
      for (let i = 0; i < 120 && settled < 3; i++) {
        await page.waitForTimeout(2000);
        last = await tileState();
        settled = last.loaded ? settled + 1 : 0;
      }
      if (settled < 3) throw new Error(`photoreal tiles never finished streaming — ${JSON.stringify(last)}`);
      await page.waitForTimeout(6000);
      // The streaming chip is driven by tileset loadProgress events; once streaming stops firing it
      // can stay pinned even though every tile is in. The mesh IS complete here, so a leftover
      // spinner in the figure would be the misleading thing.
      if ((await tileState()).chip) {
        console.log('  note: photoreal tile chip still shown after tilesLoaded — removing it for the shot');
        await page.evaluate(() => document.querySelector('.photoreal-tile-loader')?.classList.remove('visible'));
      }
      await page.evaluate(() => document.querySelector('.photoreal-rotate-hint')?.remove());
      await cleanChrome();
      await saveView('prikazi-03-realisticno');
    });

    console.log(`\n  captured (${done.length}): ${done.join(', ')}`);
    if (skipped.length) console.log(`  skipped (${skipped.length}):\n    ${skipped.join('\n    ')}`);
  });
});
