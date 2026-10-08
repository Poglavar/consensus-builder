import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';
import { parse } from '@babel/parser';

const require = createRequire(import.meta.url);
const { forEach } = require('../../frontend/js/three-scene-work.js');
const source = readFileSync(new URL('../../frontend/js/photoreal-mode.js', import.meta.url), 'utf8');

function loadTerrainGridBuilder({ onSample, onYield } = {}) {
    const names = ['buildTerrainGrid', 'cancelTerrainGridBuild', 'updateGroundTexture'];
    const ast = parse(source, { sourceType: 'script' });
    const moduleBody = ast.program.body.find(node => node.type === 'ExpressionStatement')
        .expression.callee.body.body;
    const declarations = moduleBody.filter(node => node.type === 'FunctionDeclaration'
        && names.includes(node.id.name));
    expect(declarations.map(node => node.id.name).sort()).toEqual([...names].sort());

    const fixture = {
        current: true,
        calls: [],
        yields: 0,
        oldGrid: { minX: -1, minY: -1, dx: 1, dy: 1, nx: 2, ny: 2, z: new Float32Array(4) },
        oldTexture: { disposed: false, dispose() { this.disposed = true; } },
        texture: null,
        readyGrid: null
    };
    let time = 0;
    class DataTexture {
        constructor(data, width, height) {
            this.data = data;
            this.width = width;
            this.height = height;
        }
        dispose() { this.disposed = true; }
    }
    const vector = () => ({ x: null, y: null, set(x, y) { this.x = x; this.y = y; } });
    const context = vm.createContext({
        active: true,
        internals: { scene: { updateMatrixWorld() {} } },
        tiles: {},
        terrainGrid: fixture.oldGrid,
        groundTexture: fixture.oldTexture,
        terrainGridBuildGeneration: 0,
        corridorUniforms: {
            uGroundTex: { value: fixture.oldTexture },
            uGroundMin: { value: vector() },
            uGroundInvSpan: { value: vector() }
        },
        TERRAIN_GRID_MAX: 22,
        TERRAIN_GRID_MIN_CELL_M: 12,
        TERRAIN_OPENING_RADIUS_CELLS: 2,
        TERRAIN_OBSTACLE_MIN_HEIGHT_M: 1.5,
        TERRAIN_GAP_FILL_PASSES: 2,
        sampleTileSurfaceZ(x, y) {
            fixture.calls.push([x, y]);
            time += 7;
            onSample?.(fixture, x, y);
            return x + y;
        },
        terrainBoundsForEntries() { throw new Error('supplied bounds should be used'); },
        window: null,
        console
    });
    context.window = context;
    context.THREE = {
        DataTexture,
        RedFormat: 'red',
        FloatType: 'float',
        NearestFilter: 'nearest',
        ClampToEdgeWrapping: 'clamp'
    };
    context.__threeSceneWork = {
        forEach(items, visit, options) {
            return forEach(items, visit, {
                ...options,
                now: () => time,
                yieldTask: async () => {
                    fixture.yields += 1;
                    onYield?.(fixture, context);
                }
            });
        }
    };
    context.__photorealGround = {
        cleanGroundGrid(values) { return new Float32Array(values); }
    };
    declarations.forEach(node => {
        vm.runInContext(`${source.slice(node.start, node.end)}\nthis.${node.id.name} = ${node.id.name};`, context);
    });
    return { context, fixture };
}

it('stages terrain raycasts across work slices and publishes only the completed grid/texture', async () => {
    const { context, fixture } = loadTerrainGridBuilder();
    let callbackGrid = null;
    const pending = context.buildTerrainGrid([], { minX: 0, minY: 0, maxX: 24, maxY: 24 }, grid => {
        callbackGrid = grid;
        fixture.readyGrid = context.terrainGrid;
    });

    expect(fixture.calls).toHaveLength(1);
    expect(context.terrainGrid).toBe(fixture.oldGrid);
    expect(context.groundTexture).toBe(fixture.oldTexture);
    expect(fixture.oldTexture.disposed).toBe(false);

    await expect(pending).resolves.toBe(true);
    expect(fixture.calls).toHaveLength(9);
    expect(fixture.yields).toBe(8);
    expect(callbackGrid).toBe(context.terrainGrid);
    expect(fixture.readyGrid).toBe(callbackGrid);
    expect(context.terrainGrid.z[8]).toBe(48);
    expect(fixture.oldTexture.disposed).toBe(true);
    expect(context.groundTexture).not.toBe(fixture.oldTexture);
    expect(context.groundTexture.width).toBe(3);
    expect(context.corridorUniforms.uGroundTex.value).toBe(context.groundTexture);
});

it('abandons a superseded terrain build without replacing the prior grid or texture', async () => {
    const { context, fixture } = loadTerrainGridBuilder({
        onYield(_fixture, vmContext) { vmContext.cancelTerrainGridBuild(); }
    });
    let callbackCount = 0;
    const pending = context.buildTerrainGrid([], { minX: 0, minY: 0, maxX: 24, maxY: 24 }, () => {
        callbackCount += 1;
    });

    await expect(pending).resolves.toBe(false);
    expect(fixture.calls).toHaveLength(1);
    expect(callbackCount).toBe(0);
    expect(context.terrainGrid).toBe(fixture.oldGrid);
    expect(context.groundTexture).toBe(fixture.oldTexture);
    expect(fixture.oldTexture.disposed).toBe(false);
});
