// Builds the deterministic running-bond paving texture used for square surfaces in abstract 3D.
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.__threeSquarePaving = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    function buildSquarePavingLayout(tileSize = 256) {
        const size = Math.max(64, Math.round(Number(tileSize) || 256));
        const rows = 8;
        const courseHeight = size / rows;
        const stoneWidth = size / 4;
        const joint = Math.max(1, size / 128);
        const palette = ['#c8c0ae', '#d2cab8', '#bdb5a4', '#d8d1c0', '#c3baa8'];
        const stones = [];

        for (let row = 0; row < rows; row += 1) {
            const offset = row % 2 === 0 ? 0 : -stoneWidth / 2;
            for (let column = 0; offset + column * stoneWidth < size; column += 1) {
                const x = offset + column * stoneWidth;
                stones.push({
                    x: x + joint / 2,
                    y: row * courseHeight + joint / 2,
                    width: stoneWidth - joint,
                    height: courseHeight - joint,
                    color: palette[(row * 3 + column * 2) % palette.length]
                });
            }
        }
        return { size, mortar: '#8e897f', stones };
    }

    function paintSquarePavingCanvas(documentRef, tileSize = 256) {
        if (!documentRef || typeof documentRef.createElement !== 'function') return null;
        const layout = buildSquarePavingLayout(tileSize);
        const canvas = documentRef.createElement('canvas');
        const context = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
        if (!context) return null;
        canvas.width = layout.size;
        canvas.height = layout.size;
        context.fillStyle = layout.mortar;
        context.fillRect(0, 0, layout.size, layout.size);
        layout.stones.forEach(stone => {
            context.fillStyle = stone.color;
            context.fillRect(stone.x, stone.y, stone.width, stone.height);
            context.strokeStyle = 'rgba(255,255,255,0.16)';
            context.lineWidth = 1;
            context.strokeRect(stone.x + 0.5, stone.y + 0.5, Math.max(0, stone.width - 1), Math.max(0, stone.height - 1));
        });
        return canvas;
    }

    function createSquarePavingTexture(three, documentRef, renderer) {
        if (!three || typeof three.CanvasTexture !== 'function') return null;
        const canvas = paintSquarePavingCanvas(documentRef);
        if (!canvas) return null;
        const texture = new three.CanvasTexture(canvas);
        texture.wrapS = three.RepeatWrapping;
        texture.wrapT = three.RepeatWrapping;
        // ShapeGeometry's UVs are local metric XY. One texture tile therefore spans four metres,
        // giving the running bond roughly 1 m × 0.5 m stones without adding any extra geometry.
        if (texture.repeat && typeof texture.repeat.set === 'function') texture.repeat.set(0.25, 0.25);
        try {
            const maximum = renderer?.capabilities?.getMaxAnisotropy?.();
            if (Number.isFinite(maximum)) texture.anisotropy = Math.min(8, maximum);
        } catch (_) { }
        if (three.SRGBColorSpace !== undefined) texture.colorSpace = three.SRGBColorSpace;
        else if (three.sRGBEncoding !== undefined) texture.encoding = three.sRGBEncoding;
        texture.needsUpdate = true;
        return texture;
    }

    return { buildSquarePavingLayout, paintSquarePavingCanvas, createSquarePavingTexture };
});
