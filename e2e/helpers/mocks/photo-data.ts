import { Page } from '@playwright/test';

// Protocol fixture for the real tiles renderer: a georeferenced ground plane and building.
// The application still downloads, parses, transforms, seats and renders the glTF mesh.
export async function mockPhotoTiles(page: Page) {
  let requests = 0;
  const lon = 15.9822 * Math.PI / 180, lat = 45.80025 * Math.PI / 180;
  const a = 6378137, e2 = 0.00669437999014;
  const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const transform = [
    -Math.sin(lon), Math.cos(lon), 0, 0,
    -Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat), 0,
    Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat), 0,
    n * Math.cos(lat) * Math.cos(lon), n * Math.cos(lat) * Math.sin(lon), n * (1 - e2) * Math.sin(lat), 1,
  ];
  // glTF is Y-up; the tiles renderer converts it to the tile's Z-up frame.
  const positions = [-150,0,-150, 150,0,150, 150,0,-150, -150,0,-150, -150,0,150, 150,0,150];
  const vertices = [[20,0,20],[40,0,20],[40,0,40],[20,0,40],[20,15,20],[40,15,20],[40,15,40],[20,15,40]];
  for (const face of [[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]]) {
    for (const i of [face[0],face[1],face[2],face[0],face[2],face[3]]) positions.push(...vertices[i]);
  }
  const data = Buffer.from(new Float32Array(positions).buffer);
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'FixturePhotorealMesh' }],
    meshes: [{ name: 'FixturePhotorealMesh', primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    materials: [{ doubleSided: true, pbrMetallicRoughness: { baseColorFactor: [0.5,0.65,0.4,1], metallicFactor: 0, roughnessFactor: 1 } }],
    buffers: [{ byteLength: data.length, uri: `data:application/octet-stream;base64,${data.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: data.length, target: 34962 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: positions.length / 3, type: 'VEC3', min: [-150,0,-150], max: [150,15,150] }],
  };
  await page.route('https://api.cesium.com/v1/assets/*/endpoint**', route => route.fulfill({ json: {
    type: '3DTILES', url: 'https://tiles.example.test/tileset.json', accessToken: 'fixture-token',
  } }));
  await page.route('https://tiles.example.test/tileset.json**', route => route.fulfill({ json: {
    asset: { version: '1.1', gltfUpAxis: 'Y' }, geometricError: 0,
    root: { transform, boundingVolume: { box: [0,0,7.5,150,0,0,0,150,0,0,0,7.5] }, geometricError: 0, refine: 'ADD', content: { uri: 'https://tiles.example.test/fixture.gltf' } },
  } }));
  await page.route('https://tiles.example.test/fixture.gltf**', route => {
    requests++;
    return route.fulfill({ json: gltf });
  });
  return { requests: () => requests };
}
