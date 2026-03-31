import { test, expect } from '../helpers/fixtures';
import { waitForMapReady } from '../helpers/app';

test.describe('PersistentStorage @core', () => {
  test('PersistentStorage.ready resolves', async ({ mockApi: page }) => {
    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');

    const ready = await page.evaluate(async () => {
      const w = window as any;
      if (!w.PersistentStorage) return { exists: false };
      await w.PersistentStorage.ready;
      return { exists: true, ready: true };
    });

    expect(ready.exists).toBe(true);
    expect(ready.ready).toBe(true);
  });

  test('setItem/getItem round-trips string values', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('e2e_test_key', 'hello_world');
      const value = w.PersistentStorage.getItem('e2e_test_key');
      w.PersistentStorage.removeItem('e2e_test_key');
      return { value };
    });

    expect(result.value).toBe('hello_world');
  });

  test('setItem/getItem round-trips JSON objects', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      const obj = { name: 'test', parcels: ['a', 'b'], nested: { x: 1 } };
      w.PersistentStorage.setItem('e2e_json', JSON.stringify(obj));
      const raw = w.PersistentStorage.getItem('e2e_json');
      w.PersistentStorage.removeItem('e2e_json');
      return { parsed: raw ? JSON.parse(raw) : null };
    });

    expect(result.parsed).toEqual({ name: 'test', parcels: ['a', 'b'], nested: { x: 1 } });
  });

  test('removeItem deletes a key', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('e2e_delete_me', 'value');
      const before = w.PersistentStorage.getItem('e2e_delete_me');
      w.PersistentStorage.removeItem('e2e_delete_me');
      const after = w.PersistentStorage.getItem('e2e_delete_me');
      return { before, after };
    });

    expect(result.before).toBe('value');
    expect(result.after).toBeNull();
  });

  test('getItem returns null for nonexistent key', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      return w.PersistentStorage.getItem('e2e_nonexistent_key_' + Date.now());
    });

    expect(result).toBeNull();
  });

  test('data persists across page reload', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      w.PersistentStorage.setItem('e2e_persist_test', 'survives_reload');
    });

    await page.reload();
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      const value = w.PersistentStorage.getItem('e2e_persist_test');
      w.PersistentStorage.removeItem('e2e_persist_test');
      return value;
    });

    expect(result).toBe('survives_reload');
  });

  test('forEach iterates over all stored keys', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      if (typeof w.PersistentStorage.forEach !== 'function') return { skip: true };

      w.PersistentStorage.setItem('e2e_iter_a', 'val_a');
      w.PersistentStorage.setItem('e2e_iter_b', 'val_b');

      const keys: string[] = [];
      w.PersistentStorage.forEach((_value: string, key: string) => {
        if (key.startsWith('e2e_iter_')) keys.push(key);
      });

      w.PersistentStorage.removeItem('e2e_iter_a');
      w.PersistentStorage.removeItem('e2e_iter_b');
      return { skip: false, keys: keys.sort() };
    });

    test.skip(result.skip === true, 'forEach not available');
    expect(result.keys).toEqual(['e2e_iter_a', 'e2e_iter_b']);
  });

  test('length property reflects stored item count', async ({ mockApi: page }) => {
    await page.goto('/');
    await waitForMapReady(page);

    const result = await page.evaluate(async () => {
      const w = window as any;
      await w.PersistentStorage.ready;
      if (typeof w.PersistentStorage.length === 'undefined') return { skip: true };

      const before = w.PersistentStorage.length;
      w.PersistentStorage.setItem('e2e_len_test', 'x');
      const after = w.PersistentStorage.length;
      w.PersistentStorage.removeItem('e2e_len_test');
      const restored = w.PersistentStorage.length;
      return { skip: false, increased: after > before, restored: restored === before };
    });

    test.skip(result.skip === true, 'length not available');
    expect(result.increased).toBe(true);
    expect(result.restored).toBe(true);
  });
});
