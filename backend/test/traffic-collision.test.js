import { describe, expect, it } from 'vitest';
import Collision from '../../frontend/traffic/collision.js';

const { LENGTH, WIDTH, overlaps, overlapsRectangle, Index } = Collision;
const pose = (x, y, angle = 0) => ({ x, y, angle });

function polygonOverlap(a, b, margin) {
    const corners = body => {
        const along = [Math.cos(body.angle), Math.sin(body.angle)];
        const across = [-along[1], along[0]];
        const halfLength = LENGTH / 2 + margin, halfWidth = WIDTH / 2 + margin;
        return [-1, 1].flatMap(longitudinal => [-1, 1].map(lateral => [
            body.x + longitudinal * halfLength * along[0] + lateral * halfWidth * across[0],
            body.y + longitudinal * halfLength * along[1] + lateral * halfWidth * across[1]
        ]));
    };
    const first = corners(a), second = corners(b);
    const axes = [a.angle, a.angle + Math.PI / 2, b.angle, b.angle + Math.PI / 2];
    for (const angle of axes) {
        const axis = [Math.cos(angle), Math.sin(angle)];
        const project = points => points.map(point => point[0] * axis[0] + point[1] * axis[1]);
        const firstProjection = project(first), secondProjection = project(second);
        if (Math.min(...secondProjection) - Math.max(...firstProjection) >= -1e-7
            || Math.min(...firstProjection) - Math.max(...secondProjection) >= -1e-7) return false;
    }
    return true;
}

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

    it('checks car footprints against rectangular closure barriers with the collision margin', () => {
        const car = pose(0, 0);
        expect(overlapsRectangle(car, pose(3.1, 0), 1, 3.5)).toBe(false);
        expect(overlapsRectangle(car, pose(2.8, 0), 1, 3.5)).toBe(true);
        // The exact contact threshold is 2.2 + 0.5 + .12 + .12; touching stays clear.
        expect(overlapsRectangle(car, pose(2.94, 0), 1, 3.5)).toBe(false);
    });

    it('separates perpendicular barriers and rotated rectangles whose AABBs overlap', () => {
        expect(overlapsRectangle(pose(0, 0), pose(0, 3, Math.PI / 2), 1, 3.5)).toBe(false);
        const rotatedBarrier = pose(3.7, 2.4, Math.PI / 4);
        const barrierHalfX = .5 * Math.abs(Math.cos(rotatedBarrier.angle))
            + 1.75 * Math.abs(Math.sin(rotatedBarrier.angle));
        const barrierHalfY = .5 * Math.abs(Math.sin(rotatedBarrier.angle))
            + 1.75 * Math.abs(Math.cos(rotatedBarrier.angle));
        expect(Math.abs(rotatedBarrier.x)).toBeLessThan(LENGTH / 2 + barrierHalfX);
        expect(Math.abs(rotatedBarrier.y)).toBeLessThan(WIDTH / 2 + barrierHalfY);
        // Their axis-aligned bounds overlap on x and y, but their actual boxes are apart.
        expect(overlapsRectangle(pose(0, 0), rotatedBarrier, 1, 3.5)).toBe(false);
    });

    it('allows cars travelling in adjacent lanes three metres apart', () => {
        expect(overlaps(pose(0, 0), pose(0, 3))).toBe(false);
        const index = new Index();
        index.set('northbound', pose(0, 0));
        index.set('southbound', pose(0, 3));
        expect(index.blocked('northbound', pose(0.2, 0))).toBe(false);
    });

    it('keeps the broadphase bound in sync with an enlarged overlap margin', () => {
        const first = pose(0, 0), second = pose(5, 2.4);
        expect(overlaps(first, second)).toBe(false);
        expect(overlaps(first, second, .37)).toBe(true);
    });

    it('matches polygon-corner SAT across margins and refreshes a mutated heading', () => {
        let state = 0x6d2b79f5;
        const random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 0x100000000;
        };
        const margins = [0, .12, .37];
        for (let pair = 0; pair < 1000; pair++) {
            const first = pose(random() * 20 - 10, random() * 20 - 10, random() * Math.PI * 2 - Math.PI);
            const second = pose(random() * 20 - 10, random() * 20 - 10, random() * Math.PI * 2 - Math.PI);
            for (const margin of margins) {
                expect(overlaps(first, second, margin)).toBe(polygonOverlap(first, second, margin));
            }
        }

        const mutable = pose(0, 0), other = pose(5, 2.4);
        expect(overlaps(mutable, other, .37)).toBe(polygonOverlap(mutable, other, .37));
        expect(overlaps(mutable, other, .37)).toBe(true);
        mutable.angle = Math.PI / 2;
        expect(overlaps(mutable, other, .37)).toBe(polygonOverlap(mutable, other, .37));
        expect(overlaps(mutable, other, .37)).toBe(false);
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
