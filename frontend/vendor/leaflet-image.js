/* global L */
var leafletImage = (function() {
    function getMapCanvas(map, callback) {
        var dimensions = map.getSize();
        var containerPoint = map.containerPointToLayerPoint([0, 0]);
        var layerPoint = map.layerPointToLatLng(containerPoint);
        var originalZoom = map.getZoom();
        var originalCenter = map.getCenter();

        var canvas = document.createElement('canvas');
        canvas.width = dimensions.x;
        canvas.height = dimensions.y;
        var context = canvas.getContext('2d');

        var tilesToLoad = 0;

        function handleTileLoad(tile) {
            var img = tile.el;
            var srcCoords = tile.coords;

            if (!img.complete || !img.naturalWidth) {
                tilesToLoad--;
                if (tilesToLoad === 0) {
                    finish();
                }
                return;
            }

            var tileSize = tile.layer.getTileSize();
            var nwPoint = tile.coords;
            var scaled = tile.layer._tileCoordsToKey(srcCoords);
            var layerPos = map.project(nwPoint, originalZoom);
            var topLeft = layerPos.subtract(containerPoint);

            context.drawImage(img, topLeft.x, topLeft.y, tileSize.x, tileSize.y);

            tilesToLoad--;
            if (tilesToLoad === 0) {
                finish();
            }
        }

        function finish() {
            map.setView(originalCenter, originalZoom);
            callback(null, canvas);
        }

        map.eachLayer(function(layer) {
            if (layer instanceof L.TileLayer) {
                var originalCreateTile = layer.createTile.bind(layer);
                layer.createTile = function(coords, done) {
                    tilesToLoad++;
                    var tile = originalCreateTile(coords, function(err, tileElement) {
                        handleTileLoad({
                            el: tileElement,
                            coords: coords,
                            layer: layer
                        });
                        if (done) {
                            done(err, tileElement);
                        }
                    });
                    return tile;
                };
            }
        });

        setTimeout(function() {
            if (tilesToLoad === 0) {
                finish();
            }
        }, 2000);
    }

    return function(map, callback) {
        return getMapCanvas(map, callback);
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = leafletImage;
}








