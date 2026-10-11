import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch

script_name = 'build-parcel-provider-seeds.py'
here = Path(__file__).resolve().parent
script_candidates = [here / script_name, Path.cwd() / 'scripts' / script_name]
for parent in here.parents:
    script_candidates.extend([parent / 'scripts' / script_name, parent / script_name])
script_candidates.append(Path('/private/tmp') / script_name)
SCRIPT = next((candidate for candidate in script_candidates if candidate.is_file()), None)
if SCRIPT is None:
    raise FileNotFoundError(f'cannot locate {script_name} beside tests or under a repository scripts/ directory')
spec = importlib.util.spec_from_file_location('provider_seeds', SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


class FakeCRS:
    @staticmethod
    def from_user_input(value): return value
    @staticmethod
    def from_epsg(value): return f'EPSG:{value}'


class FakeTransformer:
    called = None
    bounds_called = None
    @classmethod
    def from_crs(cls, source, target, always_xy=False):
        cls.called = (source, target, always_xy)
        return cls()
    def transform_bounds(self, left, bottom, right, top, densify_pts=0):
        type(self).bounds_called = (left, bottom, right, top, densify_pts)
        # Emulate curved edges extending beyond the four transformed corners.
        return (left - 0.5, bottom - 0.25, right + 0.5, top + 0.25)


class ProviderSeedTests(unittest.TestCase):
    def test_metadata_url_is_https_credential_free_and_only_requests_json(self):
        self.assertEqual(mod._metadata_url('https://example.gov/arcgis/rest/services/X/FeatureServer/0?f=pjson'), 'https://example.gov/arcgis/rest/services/X/FeatureServer/0?f=json')
        with self.assertRaisesRegex(ValueError, 'HTTPS'):
            mod._metadata_url('http://example.gov/FeatureServer/0')
        with self.assertRaisesRegex(ValueError, 'credentialed'):
            mod._metadata_url('https://example.gov/FeatureServer/0?token=secret')

    def test_fetch_metadata_requests_metadata_only_with_eight_second_timeout(self):
        class Response:
            status = 200
            def geturl(self): return 'https://example.gov/FeatureServer/0?f=json'
            def read(self, limit):
                self.limit = limit
                return b'{"fullExtent":{"xmin":0,"ymin":0,"xmax":1,"ymax":1,"spatialReference":{"wkid":4326}}}'
            def __enter__(self): return self
            def __exit__(self, *args): pass
        seen = {}
        def fake_urlopen(request, timeout):
            seen['url'] = request.full_url
            seen['timeout'] = timeout
            seen['method'] = request.get_method()
            return Response()
        with patch.object(mod, 'urlopen', fake_urlopen):
            data, evidence = mod.fetch_arcgis_metadata('https://example.gov/FeatureServer/0')
        self.assertIn('f=json', seen['url'])
        self.assertEqual(seen['timeout'], 8)
        self.assertEqual(seen['method'], 'GET')
        self.assertEqual(evidence['featureValuesRequested'], False)
        self.assertEqual(data['fullExtent']['spatialReference']['wkid'], 4326)

    def test_extent_transform_uses_xy_order_and_all_four_corners(self):
        fake_pyproj = types.ModuleType('pyproj')
        fake_pyproj.CRS = FakeCRS
        fake_pyproj.Transformer = FakeTransformer
        metadata = {'fullExtent': {'xmin': -3, 'ymin': 1, 'xmax': 4, 'ymax': 9, 'spatialReference': {'wkid': 4326}}}
        with patch.dict(sys.modules, {'pyproj': fake_pyproj}):
            bbox, evidence = mod.extent_wgs84(metadata)
        self.assertEqual(bbox, [-3.5, 0.75, 4.5, 9.25])
        self.assertEqual(FakeTransformer.bounds_called, (-3.0, 1.0, 4.0, 9.0, 21))
        self.assertEqual(evidence['densifyPoints'], 21)
        self.assertTrue(FakeTransformer.called[2])

    def test_endpoint_fingerprint_preserves_public_query_filters(self):
        base = {'adapter':'arcgis','endpoint':'https://example.gov/layer?where=active%3D1&f=json'}
        changed = {'adapter':'arcgis','endpoint':'https://example.gov/layer?where=active%3D0&f=pjson'}
        with_secret = {'adapter':'arcgis','endpoint':'https://example.gov/layer?where=active%3D1&token=secret'}
        self.assertNotEqual(mod._safe_endpoint_fingerprint(base), mod._safe_endpoint_fingerprint(changed))
        self.assertEqual(mod._safe_endpoint_fingerprint(base), mod._safe_endpoint_fingerprint(with_secret))

    def test_real_arcgis_layer_extent_shape_is_supported(self):
        metadata = {'type': 'Feature Layer', 'geometryType': 'esriGeometryPolygon',
                    'extent': {'xmin': 16.47, 'ymin': -34.83, 'xmax': 32.58,
                               'ymax': -22.25, 'spatialReference': {'wkid': 4148}}}
        fake_pyproj = types.ModuleType('pyproj')
        fake_pyproj.CRS = FakeCRS
        fake_pyproj.Transformer = FakeTransformer
        with patch.dict(sys.modules, {'pyproj': fake_pyproj}):
            bbox, evidence = mod.extent_wgs84(metadata)
        self.assertLessEqual(bbox[0], 16.47)
        self.assertGreaterEqual(bbox[2], 32.58)
        self.assertEqual(evidence['metadataExtentField'], 'extent')

    def test_only_passed_qualification_with_all_eight_gates_is_accepted(self):
        passed = {'status': 'technical-qualified', 'checks': {key: {'passed': True} for key in mod.CHECKS}}
        self.assertEqual(mod._qualification_passed(passed), (True, None))
        passed['checks']['metric']['passed'] = False
        ok, reason = mod._qualification_passed(passed)
        self.assertFalse(ok)
        self.assertIn('eight', reason)

    def test_regional_arcgis_extent_yields_only_unseeded_same_country_candidates(self):
        cities = [
            {'cityCode':'1','name':'Anchor','country':'A','iso2':'AA','point':[0.0,0.0],'pop2025k':20,'rank':1},
            {'cityCode':'2','name':'Target','country':'A','iso2':'AA','point':[0.1,0.1],'pop2025k':10,'rank':2},
            {'cityCode':'3','name':'Other country','country':'B','iso2':'BB','point':[0.2,0.2],'pop2025k':9,'rank':3},
        ]
        desc = {'id':'regional','name':'Regional source','adapter':'arcgis','endpoint':'https://example.gov/FeatureServer/0','cityIds':['1'],'scope':'Regional cadastre','catalogueUrl':'https://example.gov/catalogue'}
        entity = {'sourceId':'regional','descriptor':desc,'origins':['source-catalog'],'sourceCatalogIds':['regional'],'duplicateSourceIds':[],'existingSeed':None,'qualifiedSeeds':[],'evidenceFiles':[{'path':'source-catalog.json','root':'shared'}],'scopeEvidence':['Regional cadastre','https://example.gov/catalogue'],'verifiedSeedBboxes':[]}
        metadata = {'fullExtent':{'xmin':-0.1,'ymin':-0.1,'xmax':0.15,'ymax':0.15,'spatialReference':{'wkid':4326}}}
        fake_pyproj = types.ModuleType('pyproj')
        fake_pyproj.CRS = FakeCRS
        fake_pyproj.Transformer = FakeTransformer
        with tempfile.TemporaryDirectory() as td:
            repo=Path(td)/'repo'; out=repo/'tmp'/'provider-expansion'; out.mkdir(parents=True)
            with patch.dict(sys.modules, {'pyproj': fake_pyproj}):
                inv, rows = mod.evaluate_entity(entity,cities,lambda endpoint:(metadata,{'sha256':'abc','url':endpoint+'?f=json'}),set(),out,repo)
            metadata_ref=next(x for x in rows[0]['provider']['evidenceFiles'] if x['path'].startswith('tmp/provider-expansion/metadata/'))
            evidence_path=repo/metadata_ref['path']
            evidence_bytes=evidence_path.read_bytes()
            evidence=json.loads(evidence_bytes)
            evidence_stem=evidence_path.stem
        self.assertEqual(inv['status'],'metadata-ready')
        self.assertEqual(rows[0]['provider']['descriptor']['countryCode'],'AA')
        self.assertEqual([x['city']['cityCode'] for x in rows],['2'])
        self.assertEqual(rows[0]['provider']['seedCityCodes'],['1'])
        self.assertEqual(evidence['sourceCrs']['wkid'],4326)
        self.assertEqual(evidence['requestSha256'],'abc')
        self.assertFalse(evidence['featureValuesRequested'])
        self.assertEqual(evidence_stem,mod.sha256_bytes(evidence_bytes))
        self.assertFalse(inv['coverageAssertion'])

    def test_non_arcgis_without_regional_extent_stays_actionably_held(self):
        entity = {'sourceId':'wfs','descriptor':{'id':'wfs','adapter':'wfs','countryCode':'AA','cityIds':['1']},'origins':['source-catalog'],'sourceCatalogIds':['wfs'],'existingSeed':None,'qualifiedSeeds':[],'evidenceFiles':[],'scopeEvidence':[],'verifiedSeedBboxes':[]}
        cities=[{'cityCode':'1','name':'A','country':'A','iso2':'AA','point':[0,0],'rank':1,'pop2025k':1}]
        inv, rows = mod.evaluate_entity(entity,cities,lambda endpoint: self.fail('must not call ArcGIS for WFS'),set())
        self.assertEqual(inv['status'],'held-next-protocol-workflow')
        self.assertIn('WFS capability',inv['reason'])
        self.assertEqual(rows,[])

    def test_queue_sort_is_globally_by_wup_rank_then_code_then_provider(self):
        rows=[
            {'city':{'rank':2,'cityCode':'9'},'provider':{'descriptor':{'id':'b'}}},
            {'city':{'rank':1,'cityCode':'8'},'provider':{'descriptor':{'id':'z'}}},
            {'city':{'rank':1,'cityCode':'7'},'provider':{'descriptor':{'id':'a'}}},
            {'city':{'rank':1,'cityCode':'7'},'provider':{'descriptor':{'id':'b'}}},
        ]
        rows.sort(key=mod._queue_sort_key)
        self.assertEqual([(x['city']['rank'],x['city']['cityCode'],x['provider']['descriptor']['id']) for x in rows],[(1,'7','a'),(1,'7','b'),(1,'8','z'),(2,'9','b')])


if __name__ == '__main__': unittest.main(verbosity=2)
