// Bounded DGI lookup windows enabled by admitted city bindings; these are not city boundaries.
export const DGI_CITY_LOOKUP_BOUNDS = Object.freeze({
    // The near-centre discovery response includes full polygons north of its request
    // edge (up to 11.191444412980088). Include their full bounds and surrounding
    // browser grid cells so the map can render and requery them without clipping.
    bobo_dioulasso: [
        [-4.294, 11.188, -4.287, 11.194]
    ],
    ouagadougou: [
        [-1.533, 12.36, -1.526, 12.367],
        [-1.56, 12.36, -1.55, 12.37],
        [-1.445, 12.36, -1.44, 12.37],
        [-1.53, 12.3, -1.52, 12.31],
        [-1.53, 12.4, -1.52, 12.41]
    ]
});
