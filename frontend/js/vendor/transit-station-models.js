// Canonical source: zagreb-isochrone-main/website/shared/transit-station-models.js
// Keep this vendored copy byte-for-byte identical by running:
//   node scripts/sync-transit-station-models.mjs
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.TransitStationModels = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const MODEL_VERSION = 2;
    const LEVEL_HEIGHT_M = 10;
    const TYPES = Object.freeze({
        bus: Object.freeze({
            key: 'bus',
            label: 'Bus station',
            icon: 'B',
            footprintWidthM: 5,
            footprintLengthM: 18,
            level: 0,
            defaultColor: 0x2563eb
        }),
        tram: Object.freeze({
            key: 'tram',
            label: 'Tram station',
            icon: 'T',
            footprintWidthM: 5,
            footprintLengthM: 18,
            level: 0,
            defaultColor: 0x0f766e
        }),
        underground: Object.freeze({
            key: 'underground',
            label: 'Underground station',
            icon: 'M',
            // Includes both street stair houses and the accessible lift, not only the hall shell.
            footprintWidthM: 32,
            footprintLengthM: 68,
            level: -1,
            defaultColor: 0x1d4ed8
        }),
        elevated: Object.freeze({
            key: 'elevated',
            label: 'Elevated train station',
            icon: 'E',
            // Includes the switchback stair and lift beside the viaduct platform.
            footprintWidthM: 24,
            footprintLengthM: 30,
            level: 1,
            defaultPlatformHeightM: LEVEL_HEIGHT_M,
            minPlatformHeightM: 3,
            maxPlatformHeightM: 40,
            defaultColor: 0xb45309
        })
    });

    function normalizeType(value) {
        const key = String(value || '').trim().toLowerCase().replace(/[ _]+/g, '-');
        if (key === 'bus' || key === 'bus-stop' || key === 'roadside') return 'bus';
        if (key === 'tram' || key === 'tram-stop' || key === 'surface') return 'tram';
        if (key === 'underground' || key === 'metro' || key === 'subway') return 'underground';
        if (key === 'elevated' || key === 'elevated-train' || key === 'elevated-rail') return 'elevated';
        return null;
    }

    function specFor(value) {
        return TYPES[normalizeType(value)] || null;
    }

    function material(THREE, kind, options) {
        const Ctor = kind === 'physical' && THREE.MeshPhysicalMaterial
            ? THREE.MeshPhysicalMaterial
            : (THREE.MeshStandardMaterial || THREE.MeshLambertMaterial);
        return new Ctor(options);
    }

    function shadow(mesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        return mesh;
    }

    function addBox(THREE, target, mat, width, height, length, x, y, z, name) {
        const mesh = shadow(new THREE.Mesh(new THREE.BoxGeometry(width, height, length), mat));
        mesh.position.set(x || 0, y || 0, z || 0);
        if (name) mesh.name = name;
        target.add(mesh);
        return mesh;
    }

    function addCylinder(THREE, target, mat, radius, height, x, y, z, segments, name) {
        const mesh = shadow(new THREE.Mesh(
            new THREE.CylinderGeometry(radius, radius, height, segments || 10),
            mat
        ));
        mesh.position.set(x || 0, y || 0, z || 0);
        if (name) mesh.name = name;
        target.add(mesh);
        return mesh;
    }

    function addRailPair(THREE, target, mats, y, length, spacing) {
        const gauge = 1.435;
        for (const trackX of [-spacing * 0.5, spacing * 0.5]) {
            for (const side of [-1, 1]) {
                addBox(THREE, target, mats.rail, 0.075, 0.11, length,
                    trackX + side * gauge * 0.5, y, 0, 'StationRail');
            }
            for (let z = -length * 0.5 + 0.6; z <= length * 0.5 - 0.6; z += 0.75) {
                addBox(THREE, target, mats.sleeper, gauge + 0.55, 0.08, 0.18,
                    trackX, y - 0.08, z, 'StationSleeper');
            }
        }
    }

    function createBadgeMaterial(THREE, doc, spec, name) {
        if (!doc || typeof doc.createElement !== 'function' || !THREE.CanvasTexture) {
            return new THREE.MeshBasicMaterial({ color: spec.defaultColor, side: THREE.DoubleSide });
        }
        const canvas = doc.createElement('canvas');
        canvas.width = 512;
        canvas.height = 128;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = `#${spec.defaultColor.toString(16).padStart(6, '0')}`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 8;
        ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);
        ctx.fillStyle = '#ffffff';
        ctx.font = '700 64px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(spec.icon, 28, 68);
        ctx.font = '600 42px sans-serif';
        const label = String(name || spec.label).slice(0, 24);
        ctx.fillText(label, 105, 68);
        const texture = new THREE.CanvasTexture(canvas);
        if ('colorSpace' in texture && THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
        else if ('encoding' in texture && THREE.sRGBEncoding) texture.encoding = THREE.sRGBEncoding;
        texture.needsUpdate = true;
        return new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide, transparent: true });
    }

    function addBadge(THREE, target, doc, spec, name, width, y, z) {
        const badge = new THREE.Mesh(
            new THREE.PlaneGeometry(width, 1.05),
            createBadgeMaterial(THREE, doc, spec, name)
        );
        badge.name = 'StationNameSign';
        badge.position.set(0, y, z || 0);
        badge.rotation.y = Math.PI / 2;
        target.add(badge);
        return badge;
    }

    function commonMaterials(THREE, spec) {
        return {
            concrete: material(THREE, 'standard', { color: 0x929aa2, roughness: 0.92, metalness: 0.03 }),
            paleConcrete: material(THREE, 'standard', { color: 0xc8ced3, roughness: 0.94, metalness: 0.02 }),
            frame: material(THREE, 'standard', { color: 0x374151, roughness: 0.48, metalness: 0.48 }),
            accent: material(THREE, 'standard', { color: spec.defaultColor, roughness: 0.7, metalness: 0.08 }),
            tactile: material(THREE, 'standard', { color: 0xd8b94b, roughness: 0.86, metalness: 0.02 }),
            rail: material(THREE, 'standard', { color: 0x59636e, roughness: 0.42, metalness: 0.68 }),
            sleeper: material(THREE, 'standard', { color: 0x6b5544, roughness: 0.94, metalness: 0.01 }),
            glass: material(THREE, 'physical', {
                color: 0x8bd6ec,
                transparent: true,
                opacity: 0.62,
                roughness: 0.08,
                metalness: 0.05,
                transmission: THREE.MeshPhysicalMaterial ? 0.2 : 0,
                side: THREE.DoubleSide,
                depthWrite: false
            }),
            light: material(THREE, 'standard', {
                color: 0xfff3cf,
                emissive: 0xe2c46f,
                emissiveIntensity: 1.45,
                roughness: 0.28,
                metalness: 0.05
            })
        };
    }

    function addCanopy(THREE, target, mats, width, length, floorY) {
        const roofY = floorY + 3.05;
        addBox(THREE, target, mats.glass, width + 0.6, 0.18, length + 0.35,
            0, roofY, 0, 'StationCanopy');
        for (const z of [-length * 0.3, length * 0.3]) {
            for (const x of [-width * 0.35, width * 0.35]) {
                addCylinder(THREE, target, mats.frame, 0.075, 2.92,
                    x, floorY + 1.46, z, 8, 'StationCanopyPost');
            }
        }
    }

    function addPlatformEdges(THREE, target, mats, width, length, y) {
        for (const side of [-1, 1]) {
            addBox(THREE, target, mats.tactile, 0.34, 0.045, length - 0.6,
                side * (width * 0.5 - 0.22), y + 0.025, 0, 'StationTactileEdge');
        }
    }

    function createSurfaceStationModel(THREE, type, options) {
        const opts = options || {};
        const spec = TYPES[type];
        const mats = commonMaterials(THREE, spec);
        const group = new THREE.Group();
        const isBus = type === 'bus';
        group.name = isBus ? 'SharedBusStationModel' : 'SharedTramStationModel';
        const length = Number(opts.lengthM) > 4 ? Number(opts.lengthM) : 14;
        const platformName = isBus ? 'BusPlatform' : 'TramPlatform';
        const poleName = isBus ? 'BusStopPole' : 'TramStopPole';
        const flagName = isBus ? 'BusStopFlag' : 'TramStopFlag';
        addBox(THREE, group, mats.paleConcrete, 3, 0.10, length, 0, 0.05, 0, platformName);
        addPlatformEdges(THREE, group, mats, 3, length, 0.1);
        addCanopy(THREE, group, mats, 3, length, 0.1);
        addBadge(THREE, group, opts.document, spec, opts.name, length * 0.68, 2.5, 0);
        // The slender stop pole keeps the object legible when viewed end-on.
        addCylinder(THREE, group, mats.frame, 0.075, 2.6, 1.9, 1.3, -length * 0.34, 8, poleName);
        const flag = addBox(THREE, group, mats.accent, 0.12, 0.8, 0.8,
            1.9, 2.25, -length * 0.34, flagName);
        flag.userData.stationIcon = spec.icon;
        return group;
    }

    function createTramStationModel(THREE, options) {
        return createSurfaceStationModel(THREE, 'tram', options);
    }

    function createBusStationModel(THREE, options) {
        return createSurfaceStationModel(THREE, 'bus', options);
    }

    function addStairFlight(THREE, target, mats, options) {
        const opts = options || {};
        const count = Math.max(2, Math.round(opts.steps || 20));
        const startY = Number(opts.startY) || 0;
        const endY = Number(opts.endY) || 0;
        const startZ = Number(opts.startZ) || 0;
        const endZ = Number(opts.endZ) || 0;
        const width = Number(opts.width) || 2;
        const x = Number(opts.x) || 0;
        const dz = (endZ - startZ) / count;
        const dy = (endY - startY) / count;
        for (let i = 0; i < count; i++) {
            const treadDepth = Math.abs(dz) + 0.025;
            const height = Math.max(0.08, Math.abs(dy));
            addBox(THREE, target, mats.concrete, width, height, treadDepth,
                x,
                startY + dy * (i + 0.5),
                startZ + dz * (i + 0.5),
                opts.name || 'StationStairTread');
        }
    }

    function addLift(THREE, target, mats, x, z, height, baseY, name) {
        const group = new THREE.Group();
        group.name = name || 'StationLift';
        const y = baseY + height * 0.5;
        addBox(THREE, group, mats.frame, 2.5, 0.16, 2.5, x, baseY + height + 0.08, z, 'StationLiftRoof');
        for (const sx of [-1, 1]) {
            addBox(THREE, group, mats.frame, 0.12, height, 0.12, x + sx * 1.16, y, z - 1.16, 'StationLiftPost');
            addBox(THREE, group, mats.frame, 0.12, height, 0.12, x + sx * 1.16, y, z + 1.16, 'StationLiftPost');
        }
        addBox(THREE, group, mats.glass, 2.16, height - 0.2, 0.06, x, y, z - 1.16, 'StationLiftGlass');
        addBox(THREE, group, mats.glass, 2.16, height - 0.2, 0.06, x, y, z + 1.16, 'StationLiftGlass');
        addBox(THREE, group, mats.glass, 0.06, height - 0.2, 2.16, x + 1.16, y, z, 'StationLiftGlass');
        target.add(group);
        return group;
    }

    function createElevatedStationModel(THREE, options) {
        const opts = options || {};
        const spec = TYPES.elevated;
        const mats = commonMaterials(THREE, spec);
        const group = new THREE.Group();
        group.name = 'SharedElevatedTrainStationModel';
        const requestedHeight = opts.platformHeightM ?? opts.deckHeightM;
        const deckY = Number.isFinite(Number(requestedHeight)) ? Number(requestedHeight) : LEVEL_HEIGHT_M;
        const length = Number(opts.lengthM) > 8 ? Number(opts.lengthM) : 24;
        addBox(THREE, group, mats.frame, 9.2, 0.55, length + 2, 0, deckY - 0.35, 0, 'ElevatedStationDeck');
        addRailPair(THREE, group, mats, deckY + 0.08, length, 4.2);
        for (const side of [-1, 1]) {
            const x = side * 5.3;
            addBox(THREE, group, mats.paleConcrete, 3, 0.35, length,
                x, deckY + 0.18, 0, 'ElevatedStationPlatform');
            addPlatformEdges(THREE, group, mats, 3, length, deckY + 0.35);
            addCanopy(THREE, group, mats, 3, length * 0.75, deckY + 0.35);
        }
        for (const z of [-length * 0.32, length * 0.32]) {
            addBox(THREE, group, mats.concrete, 0.9, deckY, 2.2,
                0, deckY * 0.5, z, 'ElevatedStationPier');
        }
        // Compact switchback access on the right platform, matching the isochrone station grammar.
        addStairFlight(THREE, group, mats, {
            x: 8.1, width: 2, steps: 28,
            startY: 0.08, endY: deckY * 0.5,
            startZ: -4.4, endZ: 4.4,
            name: 'ElevatedStationLowerStair'
        });
        addBox(THREE, group, mats.concrete, 4.5, 0.18, 1.8,
            7.1, deckY * 0.5, 5.3, 'ElevatedStationMidLanding');
        addStairFlight(THREE, group, mats, {
            x: 6.1, width: 2, steps: 28,
            startY: deckY * 0.5, endY: deckY + 0.35,
            startZ: 4.4, endZ: -4.4,
            name: 'ElevatedStationUpperStair'
        });
        addLift(THREE, group, mats, 9.8, -5.2, deckY + 0.35, 0, 'ElevatedStationLift');
        addBadge(THREE, group, opts.document, spec, opts.name, length * 0.58, deckY + 2.65, 0);
        return group;
    }

    function addUndergroundEntrance(THREE, target, mats, x, z, direction) {
        const house = new THREE.Group();
        house.name = 'UndergroundStationEntrance';
        addBox(THREE, house, mats.frame, 3.1, 0.22, 6.8, x, 2.85, z, 'UndergroundEntranceRoof');
        for (const side of [-1, 1]) {
            addBox(THREE, house, mats.glass, 0.12, 2.7, 6.3,
                x + side * 1.45, 1.42, z, 'UndergroundEntranceWall');
        }
        addStairFlight(THREE, house, mats, {
            x, width: 2.3, steps: 36,
            startY: 0, endY: -6.2,
            startZ: z + direction * 2.5,
            endZ: z - direction * 5.5,
            name: 'UndergroundStreetStair'
        });
        target.add(house);
    }

    function createUndergroundStationModel(THREE, options) {
        const opts = options || {};
        const spec = TYPES.underground;
        const mats = commonMaterials(THREE, spec);
        const group = new THREE.Group();
        group.name = 'SharedUndergroundStationModel';
        const floorY = Number.isFinite(Number(opts.floorDepthM)) ? -Math.abs(Number(opts.floorDepthM)) : -LEVEL_HEIGHT_M;
        const length = Number(opts.lengthM) > 20 ? Number(opts.lengthM) : 60;
        const hallWidth = 18;
        addBox(THREE, group, mats.frame, hallWidth, 0.5, length,
            0, floorY - 0.25, 0, 'UndergroundStationFloor');
        addBox(THREE, group, mats.frame, hallWidth, 0.38, length,
            0, floorY + 9.4, 0, 'UndergroundStationCeiling');
        for (const side of [-1, 1]) {
            addBox(THREE, group, mats.frame, 0.48, 9.6, length,
                side * hallWidth * 0.5, floorY + 4.55, 0, 'UndergroundStationWall');
        }
        addBox(THREE, group, mats.concrete, 10, 0.9, length - 8,
            0, floorY + 0.45, 0, 'UndergroundIslandPlatform');
        addPlatformEdges(THREE, group, mats, 10, length - 8, floorY + 0.9);
        addRailPair(THREE, group, mats, floorY + 0.08, length - 1, 13.2);
        for (let z = -24; z <= 24; z += 8) {
            for (const x of [-3.3, 3.3]) {
                addBox(THREE, group, mats.light, 1.4, 0.14, 0.85,
                    x, floorY + 6, z, 'UndergroundStationLight');
            }
        }
        for (const z of [-22, 22]) {
            addCylinder(THREE, group, mats.paleConcrete, 0.22, 8.5,
                0, floorY + 5.15, z, 10, 'UndergroundStationColumn');
        }
        addUndergroundEntrance(THREE, group, mats, -11, -17, -1);
        addUndergroundEntrance(THREE, group, mats, 11, 17, 1);
        addLift(THREE, group, mats, 13.8, 15, Math.abs(floorY) + 0.2, floorY, 'UndergroundStationLift');
        addBadge(THREE, group, opts.document, spec, opts.name, 8, 2.45, -20.5);
        return group;
    }

    function createStationModel(THREE, type, options) {
        if (!THREE) throw new Error('Three.js is required to build a transit station model.');
        const key = normalizeType(type);
        if (key === 'bus') return createBusStationModel(THREE, options);
        if (key === 'tram') return createTramStationModel(THREE, options);
        if (key === 'underground') return createUndergroundStationModel(THREE, options);
        if (key === 'elevated') return createElevatedStationModel(THREE, options);
        throw new Error(`Unknown transit station type: ${type}`);
    }

    return Object.freeze({
        MODEL_VERSION,
        LEVEL_HEIGHT_M,
        TYPES,
        normalizeType,
        specFor,
        createStationModel,
        createBusStationModel,
        createTramStationModel,
        createUndergroundStationModel,
        createElevatedStationModel
    });
});
