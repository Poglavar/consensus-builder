// Meshes for the pitched roofs, attic walls, gable windows and balconies an urban rule asks for.
// The plan geometry comes from rule-building-details.js; three-mode.js supplies the scene's
// coordinate transform and its mesh bookkeeping, and calls in when it draws a planned building.
(function (root) {
    'use strict';

    const details = root.__ruleBuildingDetails;
    const SHINGLE_TILE_M = 2; // one texture repeat covers 2 × 2 m of roof

    function create({ THREE, coordsToXY, finishMesh }) {
        let shingleTexture = null;
        const roofMaterials = new Map(); // opacity → material, shared for the page's lifetime
        const materials = {
            slab: new THREE.MeshLambertMaterial({ color: 0xcfcac1 }),
            railing: new THREE.MeshLambertMaterial({ color: 0x3e444a }),
            frame: new THREE.MeshLambertMaterial({ color: 0xf1ebe0 }),
            glass: new THREE.MeshPhongMaterial({ color: 0x35525e, specular: 0x99aabb, shininess: 90 })
        };

        // Terracotta shingles in staggered courses, drawn once.
        function shingles() {
            if (shingleTexture) return shingleTexture;
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 256;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#6e2318';
            ctx.fillRect(0, 0, 256, 256);
            const rows = 8, cols = 8, w = 256 / cols, h = 256 / rows;
            let seed = 7;
            const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
            for (let r = 0; r < rows; r++) {
                const shift = (r % 2) * w / 2;
                for (let c = -1; c <= cols; c++) {
                    const x = c * w + shift, y = r * h;
                    const light = 36 + rand() * 12;
                    ctx.fillStyle = `hsl(${8 + rand() * 8}, ${62 + rand() * 12}%, ${light}%)`;
                    ctx.beginPath();
                    ctx.moveTo(x + 1.5, y + 1);
                    ctx.lineTo(x + w - 1.5, y + 1);
                    ctx.lineTo(x + w - 1.5, y + h * 0.7);
                    ctx.quadraticCurveTo(x + w / 2, y + h + 2, x + 1.5, y + h * 0.7);
                    ctx.closePath();
                    ctx.fill();
                    ctx.fillStyle = 'rgba(0,0,0,0.18)';
                    ctx.fillRect(x + 1.5, y + 1, w - 3, 2);
                }
            }
            shingleTexture = new THREE.CanvasTexture(canvas);
            shingleTexture.wrapS = shingleTexture.wrapT = THREE.RepeatWrapping;
            if ('colorSpace' in shingleTexture && THREE.SRGBColorSpace) shingleTexture.colorSpace = THREE.SRGBColorSpace;
            shingleTexture.anisotropy = 4;
            return shingleTexture;
        }

        // The roof follows the building's own see-through setting, so a ghosted plan stays ghosted.
        function roofMaterial(buildingMaterial) {
            const opacity = buildingMaterial && buildingMaterial.transparent ? buildingMaterial.opacity : 1;
            if (!roofMaterials.has(opacity)) {
                const material = new THREE.MeshLambertMaterial({ color: 0xffffff, map: shingles(), side: THREE.DoubleSide });
                if (opacity < 1) Object.assign(material, { transparent: true, opacity, depthWrite: false });
                roofMaterials.set(opacity, material);
            }
            return roofMaterials.get(opacity);
        }

        function outerRings(geometry) {
            if (!geometry) return [];
            if (geometry.type === 'Polygon') return [{ ring: geometry.coordinates[0], holes: geometry.coordinates.length > 1 }];
            if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(p => ({ ring: p[0], holes: p.length > 1 }));
            return [];
        }

        function metresPerUnitOf(geometry) {
            const first = outerRings(geometry)[0]?.ring?.[0];
            return first ? Math.cos(first[1] * Math.PI / 180) : 1;
        }

        const toXY = ring => ring.map(p => coordsToXY(p));

        // What one building gets, decided once: the roof frame comes from the whole footprint, so
        // every parcel slice of it raises its attic walls to the same roof.
        function planFor(feature, eaveM, neighbourFeatures) {
            const rule = feature?.properties?.urbanRule;
            if (!details || !rule || !(eaveM > 0)) return null;
            if (rule.roof !== 'pitched' && !(rule.balconyDepthM > 0)) return null;
            const parts = outerRings(feature.geometry);
            if (!parts.length) return null;
            const metresPerUnit = metresPerUnitOf(feature.geometry);
            const neighbours = (neighbourFeatures || []).flatMap(n => outerRings(n.geometry).map(part => toXY(part.ring)));
            // The largest part decides the ridge; other parts share it.
            const rings = parts.map(part => ({ xy: toXY(part.ring), holes: part.holes }));
            rings.sort((a, b) => Math.abs(details.signedArea(b.xy)) - Math.abs(details.signedArea(a.xy)));
            const plans = rings.map(part => details.plan(rule, part.xy, { metresPerUnit, neighbours, eaveM, hasHoles: part.holes }))
                .filter(Boolean);
            if (!plans.length) return null;
            return { eaveM, metresPerUnit, plans, frame: plans[0].frame, pitched: rule.roof === 'pitched', feature };
        }

        function meshFrom(positions, material, uvs = null) {
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            if (uvs) geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geometry.computeVertexNormals();
            const mesh = new THREE.Mesh(geometry, material);
            finishMesh(mesh, geometry);
            return mesh;
        }

        // The attic walls over one slice of the building (or the whole of it), in the slice's own
        // material so they read as the same wall carried up into the gable.
        function atticMeshes(plan, sliceFeature, material) {
            if (!plan || !plan.pitched) return [];
            const positions = [];
            for (const part of outerRings(sliceFeature.geometry)) {
                for (const wall of details.atticWalls(toXY(part.ring), plan.frame)) {
                    const p = wall.points.map(([x, y, z]) => [x, y, plan.eaveM + z]);
                    for (let i = 1; i + 1 < p.length; i++) {
                        const a = p[0], b = p[i], c = p[i + 1];
                        const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
                        const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
                        // Wall triangles that collapse onto the eave line are dropped.
                        if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-6) continue;
                        positions.push(...a, ...b, ...c);
                    }
                }
            }
            return positions.length ? [meshFrom(positions, material)] : [];
        }

        // Roof surfaces, gable windows and balconies of one building.
        function detailMeshes(plan, buildingMaterial) {
            const out = [];
            const roof = [], uv = [], slabs = [], railings = [], frames = [], glass = [];
            const mpu = plan.metresPerUnit, eave = plan.eaveM;
            for (const part of plan.plans) {
                if (part.roof) {
                    const frame = plan.frame;
                    for (const face of details.roofFaces(part.footprint, frame)) {
                        const contour = face.ring.map(p => new THREE.Vector2(p[0], p[1]));
                        for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
                            for (const index of [i, j, k]) {
                                const [x, y] = face.ring[index];
                                roof.push(x, y, eave + details.roofHeightAt(frame, x, y));
                                const alongM = (x * frame.axis[0] + y * frame.axis[1]) * mpu;
                                const acrossM = Math.abs(x * frame.normal[0] + y * frame.normal[1] - frame.ridge) * mpu / Math.cos(frame.pitch);
                                uv.push(alongM / SHINGLE_TILE_M, acrossM / SHINGLE_TILE_M);
                            }
                        }
                    }
                    for (const window of part.windows) {
                        const prisms = details.windowPrisms(window, eave, mpu);
                        frames.push(...prisms.frame); glass.push(...prisms.glass);
                    }
                }
                for (const balcony of part.balconies) {
                    const prisms = details.balconyPrisms(balcony, mpu);
                    slabs.push(...prisms.slab); railings.push(...prisms.railing);
                }
            }
            if (roof.length) out.push(meshFrom(roof, roofMaterial(buildingMaterial), uv));
            if (slabs.length) out.push(meshFrom(slabs, materials.slab));
            if (railings.length) out.push(meshFrom(railings, materials.railing));
            if (frames.length) out.push(meshFrom(frames, materials.frame));
            if (glass.length) out.push(meshFrom(glass, materials.glass));
            const props = plan.feature.properties || {};
            out.forEach(mesh => {
                mesh.castShadow = true; mesh.receiveShadow = true;
                if (props.proposalId != null) mesh.userData.proposalId = String(props.proposalId);
                if (props.parcelId != null) mesh.userData.parcelId = String(props.parcelId);
            });
            return out;
        }

        return { planFor, atticMeshes, detailMeshes };
    }

    root.__threeRuleRoofs = { create };
})(window);
