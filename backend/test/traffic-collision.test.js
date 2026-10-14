import { describe, expect, it } from 'vitest';
import Collision from '../../frontend/traffic/collision.js';

const { LENGTH, WIDTH, overlaps, Index } = Collision;
const pose = (x, y, angle = 0) => ({ x, y, angle });

describe('traffic vehicle collision geometry', () => {
    it('uses the configured vehicle footprint in oriented-box overlap checks', () => {
        expect(LENGTH).toBe(4.4);
        expect(WIDTH).toBe(1.8);
        expect(overlaps(pose(0, 0), pose(4, 0))).toBe(true);
        expect(overlaps(pose(0, 0), pose(5, 0))).toBe(false);
        // The boxes overlap where perpendicular paths cross even though their
        // longitudinal axes differ.
        expect(overlaps(pose(0, 0, 0), pose(0, 0, Math.PI / 2))).toBe(true);
    });

    it('allows cars travelling in adjacent lanes three metres apart', () => {
        expect(overlaps(pose(0, 0), pose(0, 3))).toBe(false);
        const index = new Index();
        index.set('northbound', pose(0, 0));
        index.set('southbound', pose(0, 3));
        expect(index.blocked('northbound', pose(0.2, 0))).toBe(false);
    });

    it('rejects a swept movement whose endpoints are clear but whose middle crosses another car', () => {
        const index = new Index();
        const stationary = pose(0, 0, Math.PI / 2);
        index.set('crossing', stationary);
        const before = pose(-5, 0, 0), after = pose(5, 0, 0);
        expect(overlaps(before, stationary)).toBe(false);
        expect(overlaps(after, stationary)).toBe(false);
        expect(index.blocked('moving', after, before)).toBe(true);
    });

    it('checks crossing paths with different headings at the shared conflict point', () => {
        const index = new Index();
        index.set('through', pose(0, 0, 0));
        expect(index.blocked('turning', pose(0, 0, Math.PI / 2))).toBe(true);
    });

    it('moves indexed cars between cells without stale occupancy', () => {
        const index = new Index();
        const oldPose = pose(-1, -1), newPose = pose(25, 25);
        index.set('car', oldPose);
        expect(index.nearby(oldPose).has('car')).toBe(true);
        index.set('car', newPose);
        expect(index.nearby(oldPose).has('car')).toBe(false);
        expect(index.nearby(newPose).has('car')).toBe(true);
        expect(index.blocked('other', pose(-1, -1))).toBe(false);
    });
});
