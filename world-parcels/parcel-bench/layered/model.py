#!/usr/bin/env python3
"""Layered parcel model v0: a pretrained timm encoder taking RGB plus OSM channels, and a light U-Net
decoder that predicts boundary, interior and distance-to-boundary maps at input resolution. Small on
purpose: the parcel fabric is built by deterministic reconstruction, not by the network."""
from __future__ import annotations

import timm
import torch
from torch import nn
from torch.nn import functional as F

from rgb_normalization import definition as normalization_definition, validate_definition

OUTPUTS = ('boundary', 'interior', 'distance')


def conv_block(in_channels, out_channels):
    return nn.Sequential(
        nn.Conv2d(in_channels, out_channels, 3, padding=1, bias=False), nn.BatchNorm2d(out_channels), nn.ReLU(inplace=True),
        nn.Conv2d(out_channels, out_channels, 3, padding=1, bias=False), nn.BatchNorm2d(out_channels), nn.ReLU(inplace=True))


class ParcelNet(nn.Module):
    def __init__(self, encoder='convnext_tiny', in_chans=6, pretrained=True, decoder_widths=(256, 128, 64, 32, 32),
                 rgb_normalization=None):
        super().__init__()
        self.rgb_normalization = (normalization_definition('none') if rgb_normalization is None
                                  else validate_definition(rgb_normalization))
        if self.rgb_normalization['mode'] == 'pretrained':
            if in_chans < 3:
                raise ValueError('RGB normalization requires at least three input channels')
            # These constants live in checkpoint metadata, not learned weights. Moving the model moves
            # them too; normalization never mutates the raw RGB/OSM cache or changes OSM dropout.
            for key in ('mean', 'std'):
                self.register_buffer(f'_rgb_{key}', torch.tensor(self.rgb_normalization[key], dtype=torch.float32)
                                     .reshape(1, 3, 1, 1), persistent=False)
        self.encoder = timm.create_model(encoder, pretrained=pretrained, features_only=True, in_chans=in_chans)
        channels = list(self.encoder.feature_info.channels())
        widths = list(decoder_widths)[:len(channels) - 1]
        while len(widths) < len(channels) - 1:
            widths.append(widths[-1])
        self.blocks = nn.ModuleList()
        current = channels[-1]
        for skip, width in zip(reversed(channels[:-1]), widths):
            self.blocks.append(conv_block(current + skip, width))
            current = width
        self.head = nn.Sequential(conv_block(current, 32), nn.Conv2d(32, len(OUTPUTS), 1))
        self.in_chans = in_chans
        self.encoder_name = encoder

    def forward(self, x):
        size = x.shape[-2:]
        if self.rgb_normalization['mode'] == 'pretrained':
            x = torch.cat(((x[:, :3] - self._rgb_mean) / self._rgb_std, x[:, 3:]), dim=1)
        features = self.encoder(x)
        out = features[-1]
        for block, skip in zip(self.blocks, reversed(features[:-1])):
            out = F.interpolate(out, size=skip.shape[-2:], mode='bilinear', align_corners=False)
            out = block(torch.cat([out, skip], dim=1))
        out = F.interpolate(out, size=size, mode='bilinear', align_corners=False)
        logits = self.head(out)
        return {name: logits[:, index:index + 1] for index, name in enumerate(OUTPUTS)}

    def parameter_groups(self, lr, encoder_scale):
        return [{'params': self.encoder.parameters(), 'lr': lr * encoder_scale},
                {'params': [p for n, p in self.named_parameters() if not n.startswith('encoder.')], 'lr': lr}]
