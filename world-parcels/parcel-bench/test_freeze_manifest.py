"""Synthetic integration coverage for city export splits and frozen benchmark mapping."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import export_city  # noqa: E402
import freeze_manifest  # noqa: E402


def final_only_fixture():
    screened = []
    counts = (5, 20, 30, 50)
    for bin_index, count in enumerate(counts):
        for repeat in range(3):
            x0, y0 = repeat * 6, bin_index * 6
            for dx in range(2):
                for dy in range(2):
                    x, y = x0 + dx, y0 + dy
                    screened.append({'id': f'tile_{x}_{y}', 'bbox': export_city.tile_bounds(x, y),
                                     'parcel_count': count,
                                     'source_ids': [f'{bin_index}_{repeat}_{dx}_{dy}_{i}' for i in range(3)]})
    blocks = export_city.choose_blocks(screened, seed=19, selection_blocks_per_stratum=0,
                                       final_blocks_per_stratum=3, strict_strata=True)
    holdout = {tile_id: split for block, split in blocks for tile_id in block['tiles']}
    samples = []
    for info in screened:
        if info['id'] not in holdout:
            continue
        samples.append({'id': info['id'], 'split': holdout[info['id']], 'bbox': info['bbox'],
                        'parcel_count': info['parcel_count'], 'source_ids': info['source_ids'],
                        'image': f"{holdout[info['id']]}/{info['id']}.jpg",
                        'truth': f"{holdout[info['id']]}/{info['id']}.truth.json"})
    exported_blocks = [{'split': split, 'bbox': block['bbox'], 'tiles': block['tiles'],
                        'density_bin': block['bin'], 'requested_bin': block['requested_bin'],
                        'mean_parcel_count': round(block['mean'], 1)} for block, split in blocks]
    exported = {'samples': samples, 'geographic_blocks': exported_blocks, 'crs': 'EPSG:3765',
                'tile_size_m': export_city.TILE_M, 'provenance': {'imagery': 'synthetic', 'cadastre': 'synthetic',
                'cadastral_clip': 'synthetic'}, 'stratification': {'bins': export_city.STRATA},
                'exclusions': {'prior_tile_ids': [], 'cross_split_distance_m': 500,
                               'source_ids_disjoint_across_splits': True}, 'exported_at': 'synthetic'}
    return exported, blocks


class FreezeIntegrationTests(unittest.TestCase):
    def test_zero_selection_three_final_per_bin_freezes_as_48_final_no_training(self):
        exported, blocks = final_only_fixture()
        self.assertEqual(len(blocks), 12)
        self.assertEqual({split for _, split in blocks}, {'test'})
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'export-manifest.json'
            source.write_text(json.dumps(exported))
            frozen = freeze_manifest.freeze(source, freeze_manifest.CITIES['zadar'], None)
        self.assertEqual(frozen['splits']['selection']['tiles'], [])
        self.assertEqual(len(frozen['splits']['final']['tiles']), 48)
        self.assertEqual(frozen['training_pool']['tiles'], [])

    def test_new_coastal_city_metadata_uses_authorized_state_imagery_rights(self):
        for slug, name in (('zadar', 'Zadar'), ('sibenik', 'Šibenik')):
            city = freeze_manifest.CITIES[slug]
            self.assertEqual(city['name'], name)
            self.assertEqual(city['country_code'], 'HR')
            self.assertEqual(city['legal_tradition'], freeze_manifest.LEGAL)
            self.assertEqual(city['imagery_rights'], freeze_manifest.RIGHTS)
            self.assertNotIn('geonames_id', city)


if __name__ == '__main__':
    unittest.main()
