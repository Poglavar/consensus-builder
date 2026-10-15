"""Explicit target definitions shared by training, evaluation and cache identities.

The saved controls predate this metadata: their recipes record cap/dilation and their boundary
margin was fixed at two pixels. That specific historical definition remains readable; partially
recorded new definitions and conflicting evaluation overrides are refused.
"""
from __future__ import annotations

import math

DEFAULTS = {'cap_m': 12.0, 'dilate_px': 1, 'margin_px': 2}


def target_definition(size, *, cap_m=12.0, dilate_px=1, margin_px=2):
    for name, value, minimum in (('size', size, 1), ('dilate_px', dilate_px, 0), ('margin_px', margin_px, 0)):
        if type(value) is not int or value < minimum:
            raise ValueError(f'{name} must be an integer >= {minimum}')
    if not isinstance(cap_m, (int, float)) or isinstance(cap_m, bool) or not math.isfinite(cap_m) or cap_m <= 0:
        raise ValueError('cap_m must be finite and positive')
    if margin_px * 2 >= size:
        raise ValueError('target margin cannot clear the entire grid')
    return {'format': 1, 'size': size, 'cap_m': float(cap_m), 'dilate_px': dilate_px, 'margin_px': margin_px}


def from_args(args):
    """Training fills unspecified target options once, before recording the immutable recipe."""
    values = {key: getattr(args, key) if getattr(args, key, None) is not None else value
              for key, value in DEFAULTS.items()}
    return target_definition(args.size, **values)


def cache_namespace(definition):
    values = {key: definition[key] for key in ('cap_m', 'dilate_px', 'margin_px')}
    if definition != target_definition(definition['size'], **values):
        raise ValueError('unknown target definition')
    return (f"s{definition['size']}-cap{definition['cap_m']:g}-d{definition['dilate_px']}"
            f"-m{definition['margin_px']}-targets1")


def recorded_targets(state, recipe, overrides=None, *, results=None):
    """Use the fitted checkpoint's target definition; CLI flags can assert it, never silently change it."""
    settings = recipe['args']
    if settings['size'] != state['size']:
        raise ValueError('checkpoint and recipe target grid differ')
    checkpoint, recorded = state.get('target_definition'), recipe.get('target_definition')
    if results is not None and results.get('target_definition') != checkpoint:
        raise ValueError('results and checkpoint target definitions differ')
    if checkpoint is None and recorded is None:
        if 'margin_px' in settings:
            raise ValueError('a margin-aware run is missing its explicit target definition')
        definition = target_definition(state['size'], cap_m=settings['cap_m'],
                                       dilate_px=settings['dilate_px'], margin_px=2)
    else:
        if checkpoint is None or recorded is None or checkpoint != recorded:
            raise ValueError('checkpoint and recipe target definitions differ')
        definition = target_definition(state['size'], **{key: settings[key] for key in DEFAULTS})
        if definition != checkpoint:
            raise ValueError('target definition differs from training arguments')
    for key, value in (overrides or {}).items():
        if key not in DEFAULTS:
            raise ValueError(f'unknown target override: {key}')
        if value is not None and value != definition[key]:
            raise ValueError(f'{key} override differs from fitted target definition')
    return definition
