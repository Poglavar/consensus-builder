// Current-map links preserve the selected view without turning an informal set into an agreement.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { link, capture, readCamera } = require('../../frontend/js/map-share.js');
const camera = { targetLat: 45, targetLng: 16, headingDeg: 90, pitchRad: -0.6, range: 300 };

describe('current-map sharing', () => {
    it.each(['2d', 'model', 'photo'])('preserves %s and location on an exact selection of designs', mode => {
        const url = new URL(link('https://app.example.test/designs/one,two?3d&city=old&lang=hr', {
            mode, at: '45,16,18', city: 'example', language: 'en', camera: mode === '2d' ? null : camera
        }));
        expect(url.pathname).toBe('/designs/one,two');
        expect(url.searchParams.get('at')).toBe('45,16,18');
        expect(url.searchParams.has('3d')).toBe(mode === 'model');
        expect(url.searchParams.has('photo')).toBe(mode === 'photo');
        expect(readCamera(url.searchParams.get('camera'))).toEqual(mode === '2d' ? null : camera);
    });
    it.each([null, '', '1,2', '91,2,0,-0.5,30', '1,2,0,1,30', '1,2,0,-0.5,0', 'a,2,0,-0.5,20'])('rejects invalid camera %s', value => {
        expect(readCamera(value)).toBeNull();
    });
    it('captures the view before a panel can change it', () => {
        expect(capture({ map: { getCenter: () => ({ lat: 45, lng: 16 }), getZoom: () => 18 },
            __mapModeState: { desired: 'photo' }, getThree3DGeoView: () => camera,
            i18n: { getLanguage: () => 'en' }, CityConfigManager: { getCurrentCityId: () => 'example' }
        })).toEqual({ mode: 'photo', at: '45,16,18', camera, city: 'example', language: 'en' });
    });
    it('keeps an explicit backend override so a preview link reads the same publications', () => {
        const context = capture({ map: { getCenter: () => ({ lat: 45, lng: 16 }), getZoom: () => 18 },
            location: { search: '?backend=https%3A%2F%2Fapi.example.test' } });
        expect(new URL(link('https://app.example.test/', context)).searchParams.get('backend')).toBe('https://api.example.test');
    });
});
