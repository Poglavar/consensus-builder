// Construction-site props for the model view's build-out (docs/buildout-timeline.md): one shared
// instanced tower crane for every site, the scaffold wrapping a building's top built floor, the
// excavation pit and the graded earth of roads and grounds not yet laid. Crane and scaffold take
// their colours from the build-out theme tokens (css/tokens.css --cb-buildout-*).
(function (root) {
    'use strict';
    let shared = null;

    function cssColor(THREE, name, fallback) {
        let value = '';
        try { value = root.getComputedStyle(root.document.documentElement).getPropertyValue(name).trim(); } catch (_) { value = ''; }
        return new THREE.Color(value || fallback);
    }

    // A scaffold reads as a frame of tubes: a transparent grid, one cell per 2 m (ExtrudeGeometry's
    // side UVs are in scene units).
    function scaffoldTexture(THREE) {
        const canvas = root.document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        context.strokeStyle = '#ffffff';
        context.lineWidth = 6;
        context.strokeRect(3, 3, 58, 58);
        context.lineWidth = 3;
        context.beginPath();
        context.moveTo(0, 32); context.lineTo(64, 32);
        context.stroke();
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        texture.repeat.set(0.5, 0.5);
        return texture;
    }

    // Materials live for the session, like the furniture materials: groups never own them.
    function materials(THREE) {
        if (shared?.THREE === THREE) return shared.materials;
        // A design's ground: over the city's ground, behind building faces (three-ground.js).
        const ground = color => root.__threeGround.designSurface(new THREE.MeshLambertMaterial({ color }), 2);
        shared = { THREE, materials: {
            earth: ground(0x9a7b57),
            pit: ground(0x5b4632),
            scaffold: new THREE.MeshLambertMaterial({ color: cssColor(THREE, '--cb-buildout-hatch', '#b45309'), map: scaffoldTexture(THREE),
                transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, depthWrite: false }),
            crane: new THREE.MeshLambertMaterial({ color: cssColor(THREE, '--cb-buildout-crane', '#92400e') })
        } };
        shared.box = new THREE.BoxGeometry(1, 1, 1);
        return shared.materials;
    }

    // Every crane of the scene in four instanced meshes (mast, jib, counterweight, hook line).
    // A site is { x, y, heightM, jibM, angle } in scene units horizontally (k units per metre) and
    // metres vertically.
    function cranes(THREE, sites, k) {
        if (!sites.length) return [];
        const material = materials(THREE).crane;
        const parts = ['mast', 'jib', 'counterweight', 'hook'].map(part => {
            const mesh = new THREE.InstancedMesh(shared.box, material, sites.length);
            mesh.userData.buildoutCrane = part;
            return mesh;
        });
        const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3();
        const turn = new THREE.Quaternion(), axis = new THREE.Vector3(0, 0, 1);
        sites.forEach((site, index) => {
            const h = site.heightM, jib = site.jibM, dx = Math.cos(site.angle) * k, dy = Math.sin(site.angle) * k;
            turn.setFromAxisAngle(axis, site.angle);
            const put = (mesh, along, z, sx, sy, sz) => {
                position.set(site.x + dx * along, site.y + dy * along, z);
                scale.set(sx, sy, sz);
                mesh.setMatrixAt(index, matrix.compose(position, turn, scale));
            };
            put(parts[0], 0, h / 2, 1.6 * k, 1.6 * k, h);
            put(parts[1], 0.35 * jib, h + 0.6, 1.3 * jib * k, 1.1 * k, 1.2);
            put(parts[2], -0.25 * jib, h - 0.4, 3 * k, 2.4 * k, 2.6);
            const line = Math.max(4, h * 0.45);
            put(parts[3], 0.8 * jib, h - line / 2, 0.15 * k, 0.15 * k, line);
        });
        parts.forEach(mesh => { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); });
        return parts;
    }

    root.__threeBuildout = Object.freeze({ materials, cranes });
})(window);
