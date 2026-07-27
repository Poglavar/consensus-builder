// The shared station library is deliberately renderer-neutral. A tiny Three.js-shaped test double
// exercises every builder without introducing Three.js as a backend dependency.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const models = require('../../frontend/js/vendor/transit-station-models.js');

class Object3D {
    constructor() {
        this.children = [];
        this.name = '';
        this.userData = {};
        this.position = { x: 0, y: 0, z: 0, set: (x, y, z) => Object.assign(this.position, { x, y, z }) };
        this.rotation = { x: 0, y: 0, z: 0 };
    }

    add(child) {
        this.children.push(child);
    }

    traverse(callback) {
        callback(this);
        this.children.forEach(child => child.traverse ? child.traverse(callback) : callback(child));
    }
}

class Group extends Object3D { }
class Mesh extends Object3D {
    constructor(geometry, material) {
        super();
        this.geometry = geometry;
        this.material = material;
    }
}
class Geometry { constructor(...args) { this.args = args; } }
class Material { constructor(options) { Object.assign(this, options); } }

const THREE = {
    Group,
    Mesh,
    BoxGeometry: Geometry,
    CylinderGeometry: Geometry,
    PlaneGeometry: Geometry,
    MeshStandardMaterial: Material,
    MeshLambertMaterial: Material,
    MeshPhysicalMaterial: Material,
    MeshBasicMaterial: Material,
    DoubleSide: 2
};

function namesIn(root) {
    const names = [];
    root.traverse(object => { if (object.name) names.push(object.name); });
    return names;
}

function findNamed(root, name) {
    let match = null;
    root.traverse(object => { if (!match && object.name === name) match = object; });
    return match;
}

describe('shared transit station model metadata', () => {
    it('normalizes the public aliases and exposes stable dimensions', () => {
        expect(models.normalizeType('bus stop')).toBe('bus');
        expect(models.normalizeType('tram stop')).toBe('tram');
        expect(models.normalizeType('subway')).toBe('underground');
        expect(models.normalizeType('elevated rail')).toBe('elevated');
        expect(models.specFor('metro')).toMatchObject({
            key: 'underground',
            footprintWidthM: 32,
            footprintLengthM: 68,
            level: -1
        });
        expect(models.specFor('bus')).toMatchObject({ key: 'bus', footprintWidthM: 5, footprintLengthM: 18 });
        expect(models.specFor('elevated')).toMatchObject({ defaultPlatformHeightM: 10, minPlatformHeightM: 3, maxPlatformHeightM: 40 });
        expect(models.MODEL_VERSION).toBe(2);
    });
});

describe('shared transit station builders', () => {
    it.each([
        ['bus', 'SharedBusStationModel', ['BusPlatform', 'StationCanopy', 'BusStopPole']],
        ['tram', 'SharedTramStationModel', ['TramPlatform', 'StationCanopy', 'TramStopPole']],
        ['underground', 'SharedUndergroundStationModel', ['UndergroundStationFloor', 'UndergroundIslandPlatform', 'UndergroundStationEntrance']],
        ['elevated', 'SharedElevatedTrainStationModel', ['ElevatedStationDeck', 'ElevatedStationPier', 'ElevatedStationLift']]
    ])('constructs a complete %s object graph', (type, rootName, expectedParts) => {
        const model = models.createStationModel(THREE, type, { name: 'Test station' });
        const names = namesIn(model);

        expect(model.name).toBe(rootName);
        expectedParts.forEach(name => expect(names).toContain(name));
        expect(model.children.length).toBeGreaterThan(3);
    });

    it('builds an elevated station at the requested platform height', () => {
        const model = models.createStationModel(THREE, 'elevated', { platformHeightM: 17.5 });
        expect(findNamed(model, 'ElevatedStationDeck').position.y).toBeCloseTo(17.15, 5);
        expect(findNamed(model, 'ElevatedStationPlatform').position.y).toBeCloseTo(17.68, 5);
    });

    it('fails loudly for an unsupported station type', () => {
        expect(() => models.createStationModel(THREE, 'monorail')).toThrow(/Unknown transit station type/);
    });
});
