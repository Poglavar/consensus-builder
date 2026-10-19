"""Freeze RGB preprocessing with each fit; preserve the raw inputs of historical checkpoints."""
from __future__ import annotations

import math


def validate_definition(value):
    if not isinstance(value, dict) or value.get('format') != 1:
        raise ValueError('invalid RGB normalization definition')
    mode = value.get('mode')
    if mode == 'none' and value == {'format': 1, 'mode': 'none'}:
        return dict(value)
    if mode != 'pretrained' or set(value) != {'format', 'mode', 'mean', 'std', 'pretrained_model'}:
        raise ValueError('invalid RGB normalization fields')
    if not isinstance(value['pretrained_model'], str) or not value['pretrained_model']:
        raise ValueError('RGB normalization requires its pretrained model identity')
    for key in ('mean', 'std'):
        values = value[key]
        if (not isinstance(values, (list, tuple)) or len(values) != 3 or
                any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x)
                    for x in values) or (key == 'std' and any(x <= 0 for x in values))):
            raise ValueError(f'RGB normalization {key} must contain three finite values with positive std')
    return {**value, 'mean': [float(x) for x in value['mean']], 'std': [float(x) for x in value['std']]}


def definition(mode, encoder=None):
    if mode == 'none':
        return {'format': 1, 'mode': 'none'}
    if mode != 'pretrained':
        raise ValueError(f'unknown RGB normalization mode: {mode}')
    from timm.models import get_pretrained_cfg
    config = get_pretrained_cfg(encoder)
    if config is None:
        raise ValueError(f'no pretrained configuration for {encoder}')
    return validate_definition({'format': 1, 'mode': mode, 'mean': list(config.mean),
                                'std': list(config.std), 'pretrained_model': config.hf_hub_id})


def recorded(state, recipe, *, results=None, override=None):
    """Read fitted values, refusing partial metadata or a conflicting evaluation override.

    Recipes written before this option existed used raw RGB. Their missing option is an explicit
    historical case; a newer recipe cannot silently lose its preprocessing metadata.
    """
    values = [state.get('rgb_normalization'), recipe.get('rgb_normalization')]
    if results is not None:
        values.append(results.get('rgb_normalization'))
    mode = recipe['args'].get('rgb_normalization')
    if all(value is None for value in values) and 'rgb_normalization' not in recipe['args']:
        fitted = definition('none')
    else:
        if any(value is None for value in values) or any(value != values[0] for value in values):
            raise ValueError('checkpoint, recipe and results RGB normalization differ')
        fitted = validate_definition(values[0])
        if mode != fitted['mode']:
            raise ValueError('RGB normalization differs from training arguments')
    if override is not None and override != fitted['mode']:
        raise ValueError('RGB normalization override differs from the fitted checkpoint')
    return fitted
