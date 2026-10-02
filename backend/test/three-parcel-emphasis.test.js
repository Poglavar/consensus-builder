import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { apply, styleFor } = require('../../frontend/js/three-parcel-emphasis.js');
const threeModeSource = readFileSync(new URL('../../frontend/js/three-mode.js', import.meta.url), 'utf8');

function color(hex) {
    const channels = (value) => ({
        r: ((value >> 16) & 0xff) / 255,
        g: ((value >> 8) & 0xff) / 255,
        b: (value & 0xff) / 255
    });
    const current = channels(hex);
    return {
        get hex() { return (Math.round(current.r * 255) << 16) | (Math.round(current.g * 255) << 8) | Math.round(current.b * 255); },
        set(next) { Object.assign(current, channels(next)); return this; },
        multiplyScalar(scale) { current.r *= scale; current.g *= scale; current.b *= scale; return this; }
    };
}

function material(hex, emissive = 0) {
    return {
        color: color(hex),
        emissive: color(emissive),
        clone() { return material(this.color.hex, this.emissive.hex); }
    };
}

function scene(...objects) {
    return {
        traverse(callback) {
            callback(this);
            objects.forEach(callback);
        }
    };
}

describe('3D parcel emphasis', () => {
    it('distinguishes the selected parcel from all surrounding geometry', () => {
        expect(styleFor({ isParcel: true, parcelId: 'parcel-a' }, 'parcel-a')).toBe('selected');
        expect(styleFor({ isParcel: true, parcelId: 'parcel-b' }, 'parcel-a')).toBe('dimmed');
        expect(styleFor({ isParcel: false }, 'parcel-a')).toBe('dimmed');
        expect(styleFor({ isParcel: true, parcelId: 'parcel-a' }, null)).toBe('normal');
    });

    it('colors one parcel, dims other objects, keeps them visible, and restores shared materials', () => {
        const shared = material(0xdddddd);
        const selected = { userData: { isParcel: true, parcelId: 'parcel-a' }, material: shared, visible: true };
        const other = { userData: { isParcel: true, parcelId: 'parcel-b' }, material: shared, visible: true };
        const building = { userData: { isBuilding: true }, material: shared, visible: true };
        const root = scene(selected, other, building);
        const originals = new WeakMap();

        apply(root, 'parcel-a', originals);
        expect(selected.material).not.toBe(shared);
        expect(selected.material.color.hex).toBe(0x29c8ff);
        expect(other.material.color.hex).toBe(0x353535);
        expect(building.material.color.hex).toBe(0x353535);
        expect([selected.visible, other.visible, building.visible]).toEqual([true, true, true]);
        expect(shared.color.hex).toBe(0xdddddd);

        // Reapplying after streamed geometry changes restores before making fresh clones.
        apply(root, 'parcel-a', originals);
        apply(root, null, originals);
        expect(selected.material).toBe(shared);
        expect(other.material).toBe(shared);
        expect(building.material).toBe(shared);
        expect([selected.visible, other.visible, building.visible]).toEqual([true, true, true]);
    });

    it('handles material arrays without mutating their shared entries', () => {
        const left = material(0xffffff);
        const right = material(0xeeeeee);
        const object = { userData: { isParcel: true, parcelId: 'selected' }, material: [left, right] };
        const originals = new WeakMap();
        apply(scene(object), 'selected', originals);
        expect(object.material.map(entry => entry.color.hex)).toEqual([0x29c8ff, 0x29c8ff]);
        apply(scene(object), null, originals);
        expect(object.material).toEqual([left, right]);
    });

    it('keeps parcel selection on the current camera and leaves proposal isolation separate', () => {
        const parcelSelection = threeModeSource.slice(
            threeModeSource.indexOf('function isolateParcel('),
            threeModeSource.indexOf('function frameIsolatedFeatures(')
        );
        expect(parcelSelection).toContain('applyParcelEmphasis();');
        expect(parcelSelection).not.toContain('frameIsolatedFeatures(');
        expect(parcelSelection).not.toContain('applyIsolationVisibility(');
        expect(parcelSelection).toContain('notifyIsolationChanged();');
        expect(threeModeSource).toContain('function isolateProposal(proposalId)');
        expect(threeModeSource).toContain('applyIsolationVisibility(idSet, feats);');
        expect(threeModeSource).toContain('frameIsolatedFeatures(feats);');
    });
});
