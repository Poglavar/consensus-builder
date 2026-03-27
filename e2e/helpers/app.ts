import { Page, expect } from '@playwright/test';
import { selectors } from './selectors';

/**
 * Wait for the Leaflet map to be initialized and tiles to start loading.
 */
export async function waitForMapReady(page: Page): Promise<void> {
  await page.waitForSelector(selectors.leafletContainer, { timeout: 15_000 });
  // Wait for at least one tile image to load
  await page.waitForFunction(() => {
    const tiles = document.querySelectorAll('.leaflet-tile-pane img');
    return tiles.length > 0;
  }, { timeout: 15_000 });
}

/**
 * Wait for parcel data to be loaded (parcelDataLoaded event has fired
 * or the overlay pane contains vector content).
 */
export async function waitForParcelsLoaded(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as any;
    // Check if parcel layer has features
    if (w.parcelLayer && typeof w.parcelLayer.getLayers === 'function') {
      return w.parcelLayer.getLayers().length > 0;
    }
    return false;
  }, { timeout: 15_000 });
}

/**
 * Zoom the map to a level where parcels load (≥17).
 */
export async function zoomToParcelLevel(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as any;
    if (w.map && typeof w.map.setZoom === 'function') {
      w.map.setZoom(18);
    }
  });
  // Wait for zoom animation to settle
  await page.waitForTimeout(1000);
}

/**
 * Get the current map zoom level.
 */
export async function getMapZoom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = window as any;
    if (w.map && typeof w.map.getZoom === 'function') {
      return w.map.getZoom();
    }
    return -1;
  });
}

/**
 * Get the current map center as [lat, lng].
 */
export async function getMapCenter(page: Page): Promise<[number, number]> {
  return page.evaluate(() => {
    const w = window as any;
    if (w.map && typeof w.map.getCenter === 'function') {
      const c = w.map.getCenter();
      return [c.lat, c.lng];
    }
    return [0, 0];
  });
}

/**
 * Click on the map at specific pixel offset from center.
 */
export async function clickMapAt(page: Page, offsetX = 0, offsetY = 0): Promise<void> {
  const mapEl = page.locator(selectors.leafletContainer);
  const box = await mapEl.boundingBox();
  if (!box) throw new Error('Map container not found');
  const x = box.x + box.width / 2 + offsetX;
  const y = box.y + box.height / 2 + offsetY;
  await page.mouse.click(x, y);
}

/**
 * Pan the map by dragging from center.
 */
export async function panMap(page: Page, deltaX: number, deltaY: number): Promise<void> {
  const mapEl = page.locator(selectors.leafletContainer);
  const box = await mapEl.boundingBox();
  if (!box) throw new Error('Map container not found');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + deltaX, cy + deltaY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/**
 * Switch to a city by evaluating CityConfigManager.
 */
export async function switchCity(page: Page, cityId: string): Promise<void> {
  await page.evaluate((id) => {
    const w = window as any;
    if (w.CityConfigManager && typeof w.CityConfigManager.setCity === 'function') {
      w.CityConfigManager.setCity(id);
    }
  }, cityId);
  await page.waitForTimeout(1000);
}

/**
 * Switch language via the i18n API.
 */
export async function switchLanguage(page: Page, langCode: string): Promise<void> {
  await page.evaluate((lang) => {
    const w = window as any;
    if (w.i18n && typeof w.i18n.setLanguage === 'function') {
      w.i18n.setLanguage(lang);
    }
  }, langCode);
  await page.waitForTimeout(500);
}

/**
 * Get the current language.
 */
export async function getLanguage(page: Page): Promise<string> {
  return page.evaluate(() => {
    const w = window as any;
    if (w.i18n && typeof w.i18n.getLanguage === 'function') {
      return w.i18n.getLanguage();
    }
    return '';
  });
}

/**
 * Collect console errors during a test.
 * Returns an array of error message strings.
 */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
    }
  });
  return errors;
}

/**
 * Collect uncaught page errors.
 */
export function collectPageErrors(page: Page): Error[] {
  const errors: Error[] = [];
  page.on('pageerror', (err) => {
    errors.push(err);
  });
  return errors;
}

/**
 * Clear browser storage (localStorage + IndexedDB) for a clean state.
 */
export async function clearStorage(page: Page): Promise<void> {
  await page.evaluate(() => {
    try { localStorage.clear(); } catch (_) {}
    try {
      const dbs = indexedDB.databases ? indexedDB.databases() : Promise.resolve([]);
      dbs.then((databases: any[]) => {
        databases.forEach((db: any) => {
          if (db.name) indexedDB.deleteDatabase(db.name);
        });
      });
    } catch (_) {}
  });
}
