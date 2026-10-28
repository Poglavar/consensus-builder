// Free placement may leave its initial site; explicit locking and snapping guide the same geometry.
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as turf from '@turf/turf';
const require = createRequire(import.meta.url);
const placement = require('../../frontend/js/on-map-placement.js');
const geometry = require('../../frontend/js/single-building-geometry.js');
const siteApi = require('../../frontend/js/proposals/site-draft.js');
const center = { lat: 45.8, lng: 16 };
const rectangle = (point, width) => turf.polygon([geometry.buildRectangleRing(point, { widthM: width, lengthM: width })]);
function element() {
    return {
        children: [], dataset: {}, listeners: {}, hidden: false,
        appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
        insertBefore(child, before) { child.parentNode = this; const i = this.children.indexOf(before); this.children.splice(i < 0 ? this.children.length : i, 0, child); },
        remove() { this.parentNode.children = this.parentNode.children.filter(node => node !== this); },
        setAttribute: vi.fn(), addEventListener(name, callback) { this.listeners[name] = callback; }
    };
}
function runtime() {
    const site = rectangle(center, 40);
    const map = {
        on: vi.fn(), off: vi.fn(), hasLayer: () => false, getZoom: () => 20,
        getBounds: () => ({ getWest: () => 15.9, getEast: () => 16.1, getSouth: () => 45.7, getNorth: () => 45.9 })
    };
    const content = element(); const body = element(); content.appendChild(body);
    const env = { document: { createElement: element }, SingleBuildingGeometry: geometry, __siteDraft: siteApi, turf,
        LiveParcelFabric: { queryBounds: vi.fn(() => []) } };
    const onLockChange = vi.fn();
    const controller = placement.create({ session: { content, body, map }, site, onLockChange }, env);
    return { controller, content, body, map, env, site, onLockChange };
}

describe('physical proposal placement', () => {
    it('allows leaving the original parcel without warning, cropping or relocating the design', () => {
        const { controller, content } = runtime();
        const outside = rectangle({ lat: center.lat, lng: center.lng + 0.002 }, 20);
        const before = JSON.stringify(outside);
        expect(controller.locked).toBe(false);
        expect(controller.accepts(outside)).toBe(true);
        controller.update(outside);
        const warning = content.children[0];
        expect(warning.hidden).toBe(true);
        expect(warning.textContent).toBe('');
        expect(controller.setLocked(true)).toBe(false);
        expect(controller.locked).toBe(false);
        expect(warning.textContent).toContain('before locking');
        expect(JSON.stringify(outside)).toBe(before);
    });
    it('enforces containment only while the optional lock is enabled', () => {
        const { controller, onLockChange } = runtime();
        const outside = rectangle({ lat: center.lat + 0.002, lng: center.lng }, 20);
        controller.update(rectangle(center, 20));
        expect(controller.setLocked(true)).toBe(true);
        expect(controller.accepts(outside)).toBe(false);
        expect(onLockChange).toHaveBeenLastCalledWith(true);
        controller.setLocked(false);
        expect(controller.accepts(outside)).toBe(true);
    });
    it('snaps the footprint by a rigid move and supports both Alt and checkbox bypasses', () => {
        const { controller, site, env } = runtime();
        const building = rectangle(center, 10);
        const a = building.geometry.coordinates[0][0]; const b = site.geometry.coordinates[0][0];
        const close = geometry.moveCoordinateCollection(b, center, { lat: center.lat + 0.4 / 111320, lng: center.lng });
        const raw = geometry.moveCoordinateCollection([center.lng, center.lat], { lng: a[0], lat: a[1] }, { lng: close[0], lat: close[1] });
        const target = { lng: raw[0], lat: raw[1] };
        const snapped = controller.moveGeometry(building.geometry, center, target);
        expect(turf.distance(turf.point(snapped.coordinates[0][0]), turf.point(b), { units: 'meters' })).toBeLessThan(0.002);
        expect(turf.area(turf.feature(snapped))).toBeCloseTo(turf.area(building), 2);
        expect(controller.moveTarget(building.geometry, center, target, { originalEvent: { altKey: true } })).toEqual(target);
        controller.setSnapping(false); env.LiveParcelFabric.queryBounds.mockClear();
        expect(controller.moveTarget(building.geometry, center, target)).toEqual(target);
        expect(env.LiveParcelFabric.queryBounds).not.toHaveBeenCalled();
    });
    it('cleans up its controls and listeners with the editor', () => {
        const { controller, content, body, map } = runtime(); controller.destroy();
        expect(body.children).toHaveLength(0); expect(content.children).toEqual([body]);
        expect(map.off).toHaveBeenCalledWith('moveend zoomend layeradd layerremove', expect.any(Function));
    });
    it('moves holes, paths, furniture and altitude in the same metric frame without mutating the source', () => {
        const outer = geometry.buildRectangleRing(center, { widthM: 30, lengthM: 40 });
        const inner = geometry.buildRectangleRing(center, { widthM: 10, lengthM: 20 });
        const source = { type: 'Polygon', coordinates: [outer, inner] }; const before = JSON.stringify(source);
        const target = { lat: 48, lng: 17 }; const moved = geometry.moveGeometry(source, center, target);
        const contents = [[outer[0], outer[1]], [inner[0]], [center.lng, center.lat, 27]];
        const translated = geometry.moveCoordinateCollection(contents, center, target);
        expect(translated[0]).toEqual(moved.coordinates[0].slice(0, 2));
        expect(translated[1][0]).toEqual(moved.coordinates[1][0]);
        expect(translated[2][0]).toBeCloseTo(target.lng, 9); expect(translated[2][1]).toBeCloseTo(target.lat, 9);
        expect(translated[2][2]).toBe(27); expect(JSON.stringify(source)).toBe(before);
    });
});
