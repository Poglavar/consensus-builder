// The 3D model view's sky: one gradient dome (zenith to horizon, warm toward a low sun, the sun's
// disc) and, at night, one star field, both behind everything at infinite distance. The
// colours come from sky-colors.js for the sun three-sun.js resolved; update() writes uniforms only
// when the sun moved, so an idle view does no sky work. Photo view hides it (the tiles keep their own
// background). UMD: window.__threeSky in the browser, require()-able in node.
(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSky = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
    'use strict';

    const colorsApi = () => (root && root.SkyColors) || require('./sky-colors.js');

    // Rotation only (the view matrix without its translation) and z = w: the dome sits at infinite
    // distance around the camera wherever it moves, with no per-frame work in JavaScript.
    const DOME_VERTEX = `
varying vec3 vCbSkyDir;
void main() {
    vCbSkyDir = position;
    gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
}`;
    // The sky's colour in a world direction (z up), with its uniforms: the dome draws it, and the
    // water reflects it (three-water-sheen.js), so the two always show the same sky.
    const SKY_COLOR_GLSL = `
uniform vec3 cbSkyZenith;
uniform vec3 cbSkyHorizon;
uniform vec3 cbSkyGlow;
uniform vec3 cbSkySun;
uniform float cbSkyGlowStrength;
uniform float cbSkySunDisc;
vec3 cbSkyColor(vec3 dir) {
    float up = clamp(dir.z, 0.0, 1.0);
    vec3 color = mix(cbSkyHorizon, cbSkyZenith, pow(up, 0.5));
    // The glow: a band along the horizon on the sun's side, and a halo around the sun itself.
    vec2 across = dir.xy / max(length(dir.xy), 1e-4);
    vec2 sunAcross = cbSkySun.xy / max(length(cbSkySun.xy), 1e-4);
    float toward = dot(across, sunAcross) * 0.5 + 0.5;
    float facing = max(dot(dir, cbSkySun), 0.0);
    float band = toward * toward * toward * exp(-up * 8.0);
    float glow = 0.9 * band + 0.5 * pow(facing, 48.0);
    color = mix(color, cbSkyGlow, clamp(cbSkyGlowStrength * glow, 0.0, 1.0));
    return mix(color, vec3(1.0, 0.95, 0.84), smoothstep(0.9999, 0.99995, facing) * cbSkySunDisc);
}`;
    const DOME_FRAGMENT = SKY_COLOR_GLSL + `
varying vec3 vCbSkyDir;
void main() {
    gl_FragColor = vec4(cbSkyColor(normalize(vCbSkyDir)), 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
}`;
    const STAR_VERTEX = `
attribute float cbStarSize;
attribute float cbStarBrightness;
uniform float cbStarStrength;
uniform float cbStarPixelRatio;
varying float vCbStar;
void main() {
    gl_Position = (projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0)).xyww;
    gl_PointSize = cbStarSize * cbStarPixelRatio;
    vCbStar = cbStarBrightness * cbStarStrength * smoothstep(0.05, 0.2, position.z);
}`;
    const STAR_FRAGMENT = `
varying float vCbStar;
void main() {
    float fade = 1.0 - smoothstep(0.15, 0.5, length(gl_PointCoord - 0.5));
    gl_FragColor = vec4(vec3(0.86, 0.9, 1.0) * vCbStar * fade, 1.0);
    #include <colorspace_fragment>
}`;

    // The sky is drawn at the far plane after every ordinary opaque object, so the depth test leaves
    // only the pixels nothing covers to shade, and before the ghost buildings' depth pre-pass
    // (three-smooth-transparency.js, render order 1e6) and the transparent pass, which blend over it.
    const SKY_RENDER_ORDER = 999000;

    // The sky for one scene. Its objects are never picked, culled, depth-written or shadowed; the
    // scene's disposal releases their geometry and materials.
    function createSky(THREE, { pixelRatio = 1 } = {}) {
        const uniforms = {
            cbSkyZenith: { value: new THREE.Color() },
            cbSkyHorizon: { value: new THREE.Color() },
            cbSkyGlow: { value: new THREE.Color() },
            cbSkySun: { value: new THREE.Vector3(0, -1, 0) },
            cbSkyGlowStrength: { value: 0 },
            cbSkySunDisc: { value: 0 }
        };
        const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
            uniforms, vertexShader: DOME_VERTEX, fragmentShader: DOME_FRAGMENT,
            side: THREE.BackSide, depthWrite: false
        }));
        const field = colorsApi().starField();
        const starGeometry = new THREE.BufferGeometry();
        starGeometry.setAttribute('position', new THREE.BufferAttribute(field.positions, 3));
        starGeometry.setAttribute('cbStarSize', new THREE.BufferAttribute(field.sizes, 1));
        starGeometry.setAttribute('cbStarBrightness', new THREE.BufferAttribute(field.brightness, 1));
        const starUniforms = { cbStarStrength: { value: 0 }, cbStarPixelRatio: { value: pixelRatio } };
        const stars = new THREE.Points(starGeometry, new THREE.ShaderMaterial({
            uniforms: starUniforms, vertexShader: STAR_VERTEX, fragmentShader: STAR_FRAGMENT,
            depthWrite: false, blending: THREE.AdditiveBlending
        }));
        const group = new THREE.Group();
        group.name = 'Sky';
        [dome, stars].forEach((object, index) => {
            object.frustumCulled = false;
            object.renderOrder = SKY_RENDER_ORDER + index;
            object.raycast = () => { };
            object.userData.cbSky = true;
            group.add(object);
        });
        stars.visible = false;

        let shownKey = null;
        // sun: { altitudeDeg, azimuthRad } or null (sun layer off); hidden: photo view. Returns
        // whether anything changed.
        function update(sun, hidden = false) {
            const key = hidden ? 'hidden'
                : sun ? `${sun.altitudeDeg.toFixed(2)}|${sun.azimuthRad.toFixed(3)}` : 'neutral';
            if (key === shownKey) return false;
            shownKey = key;
            group.visible = !hidden;
            if (hidden) return true;
            const api = colorsApi();
            const sky = api.skyColors(sun ? sun.altitudeDeg : null);
            uniforms.cbSkyZenith.value.setRGB(...sky.zenith, THREE.SRGBColorSpace);
            uniforms.cbSkyHorizon.value.setRGB(...sky.horizon, THREE.SRGBColorSpace);
            uniforms.cbSkyGlow.value.setRGB(...sky.glow, THREE.SRGBColorSpace);
            uniforms.cbSkyGlowStrength.value = sky.glowStrength;
            uniforms.cbSkySunDisc.value = sky.sunDisc;
            const direction = sun ? api.sunDirection(sun.altitudeDeg * Math.PI / 180, sun.azimuthRad) : null;
            if (direction) uniforms.cbSkySun.value.set(direction.x, direction.y, direction.z);
            starUniforms.cbStarStrength.value = sky.stars;
            stars.visible = sky.stars > 0;
            return true;
        }

        function setPixelRatio(ratio) { starUniforms.cbStarPixelRatio.value = ratio; }

        return { group, update, setPixelRatio, uniforms, starUniforms };
    }

    return { createSky, SKY_RENDER_ORDER, DOME_FRAGMENT, SKY_COLOR_GLSL };
});
