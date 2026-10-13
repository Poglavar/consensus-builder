"""Pure RGB imagery perturbations for layered parcel benchmarks."""
from __future__ import annotations

import cv2
import numpy as np

CASES = {
    'clean': {},
    'resample-0.5m': {'gsd_m': 0.5},
    'resample-1m': {'gsd_m': 1.0},
    'blur-0.3m': {'blur_sigma_m': 0.3},
    'haze-15pct': {'haze': 0.15},
    'shift-east-2m': {'east_m': 2.0},
    'shift-west-2m': {'east_m': -2.0},
    'shift-north-2m': {'north_m': 2.0},
    'shift-south-2m': {'north_m': -2.0},
}


def perturb_rgb(image, bbox, *, gsd_m=0.0, blur_sigma_m=0.0, haze=0.0, east_m=0.0, north_m=0.0):
    """Apply a physical-scale perturbation to CHW RGB in [0, 1], never changing the caller's array.
    Resampling is applied to the model input, not the original sensor data. Blur uses a Gaussian; haze
    mixes with a constant 0.9 grey. Positive east/north moves image content right/up. Reflection pads
    missing border pixels, so shifts are approximate alignment stress tests, not new observations.
    """
    if image.ndim != 3 or image.shape[0] != 3 or not np.isfinite(image).all():
        raise ValueError('expected finite CHW RGB')
    values = (gsd_m, blur_sigma_m, haze, east_m, north_m, *bbox)
    if not all(np.isfinite(v) for v in values) or gsd_m < 0 or blur_sigma_m < 0 or not 0 <= haze <= 1:
        raise ValueError('invalid imagery perturbation')
    height, width = image.shape[1:]
    x_m = (bbox[2] - bbox[0]) / width
    y_m = (bbox[3] - bbox[1]) / height
    if x_m <= 0 or y_m <= 0:
        raise ValueError('bbox must have positive width and height')
    rgb = np.ascontiguousarray(image.transpose(1, 2, 0), dtype=np.float32).copy()
    if gsd_m:
        # A finer requested grid must not manufacture detail or add an up/down-sampling blur.
        coarse = (max(1, min(width, round(width * x_m / gsd_m))),
                  max(1, min(height, round(height * y_m / gsd_m))))
        if coarse != (width, height):
            rgb = cv2.resize(cv2.resize(rgb, coarse, interpolation=cv2.INTER_AREA),
                             (width, height), interpolation=cv2.INTER_LINEAR)
    if blur_sigma_m:
        rgb = cv2.GaussianBlur(rgb, (0, 0), sigmaX=blur_sigma_m / x_m,
                               sigmaY=blur_sigma_m / y_m, borderType=cv2.BORDER_REFLECT_101)
    if haze:
        rgb = rgb * (1.0 - haze) + 0.9 * haze
    if east_m or north_m:
        matrix = np.array([[1, 0, east_m / x_m], [0, 1, -north_m / y_m]], dtype=np.float32)
        rgb = cv2.warpAffine(rgb, matrix, (width, height), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_REFLECT_101)
    return np.ascontiguousarray(np.clip(rgb, 0, 1).transpose(2, 0, 1))


def augment_resolution(image, bbox, *, seed, epoch, index, probability, max_gsd_m):
    """Randomly reduce imagery resolution on a reproducible sample/epoch-specific branch."""
    try:
        probability, max_gsd_m = float(probability), float(max_gsd_m)
    except (TypeError, ValueError) as error:
        raise ValueError('probability and max_gsd_m must be finite numbers') from error
    if not np.isfinite(probability) or not 0 <= probability <= 1:
        raise ValueError('probability must be between 0 and 1')
    if not np.isfinite(max_gsd_m) or max_gsd_m <= 0:
        raise ValueError('max_gsd_m must be finite and positive')
    if image.ndim != 3 or image.shape[0] != 3 or image.shape[1] <= 0 or image.shape[2] <= 0:
        raise ValueError('expected CHW RGB')
    try:
        bounds = tuple(float(value) for value in bbox)
    except (TypeError, ValueError) as error:
        raise ValueError('bbox must contain four finite coordinates') from error
    if len(bounds) != 4 or not np.isfinite(bounds).all():
        raise ValueError('bbox must contain four finite coordinates')
    height, width = image.shape[1:]
    x_m = (bounds[2] - bounds[0]) / width
    y_m = (bounds[3] - bounds[1]) / height
    if x_m <= 0 or y_m <= 0:
        raise ValueError('bbox must have positive width and height')
    native_gsd_m = max(x_m, y_m)
    if max_gsd_m <= native_gsd_m or probability == 0:
        return image

    rng = np.random.default_rng([seed, epoch, index, 1])
    if rng.random() >= probability:
        return image
    return perturb_rgb(image, bounds, gsd_m=rng.uniform(native_gsd_m, max_gsd_m))
