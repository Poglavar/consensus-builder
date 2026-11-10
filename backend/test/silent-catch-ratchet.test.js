// Ratchet: no frontend file may gain a silent `catch {}` or `.catch(() => {})`; the per-file counts may only shrink.
import { describe, expect, it } from 'vitest';
import { countSilentCatches, currentCounts, readBaseline } from './helpers/silent-catch-audit.mjs';

describe('silent catch handlers', () => {
    it('counts empty handlers and lets a commented one through', () => {
        expect(countSilentCatches('try { a(); } catch (_) {}')).toBe(1);
        expect(countSilentCatches('try { a(); } catch {}')).toBe(1);
        expect(countSilentCatches('p.catch(() => {});')).toBe(1);
        expect(countSilentCatches('p.catch(function () {});')).toBe(1);
        expect(countSilentCatches('try { a(); } catch (_) { /* storage may be blocked in private mode */ }')).toBe(0);
        expect(countSilentCatches('try { a(); } catch (e) { report(e); }')).toBe(0);
        expect(countSilentCatches('p.catch(error => console.error(error));')).toBe(0);
    });

    it('adds no silent handler to any frontend file (rerun silent-catch-audit.mjs --write after lowering)', () => {
        const baseline = readBaseline();
        const grown = Object.entries(currentCounts())
            .filter(([file, count]) => count > (baseline[file] ?? 0))
            .map(([file, count]) => `${file}: ${count} > ${baseline[file] ?? 0}`);
        expect(grown).toEqual([]);
    });
});
