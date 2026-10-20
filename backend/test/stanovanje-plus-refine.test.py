"""Targeted headless unit tests for grounded CAD reconstruction, no model calls."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import tempfile
import unittest

SCRIPT=Path(__file__).resolve().parents[1]/'scripts/stanovanje-plus-refine.py'
spec=importlib.util.spec_from_file_location('stanovanje_refine',SCRIPT)
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def sub(points,closed=False,curved=False):
    return {'points':points,'closed':closed,'curved':curved}


def path(id,layer,subs,fill='none'):
    return {'id':id,'layer':layer,'subpaths':subs,'fill':fill}


class RefineTests(unittest.TestCase):
    def test_door_pair_recovers_hinge_closed_tip_and_leaf(self):
        arc=[[math.cos(t*math.pi/24),math.sin(t*math.pi/24)] for t in range(13)]
        e={'paths':[path('leaf','input|vrata',[sub([[0,0],[1,0]])]),path('arc','input|vrata',[sub(arc,curved=True)])]}
        doors=m.door_candidates(e)
        self.assertEqual(len(doors),1)
        self.assertEqual(doors[0]['hinge'],[0,0]);self.assertEqual(doors[0]['openTip'],[1,0]);self.assertEqual(doors[0]['b'],[0,1])
        self.assertEqual(doors[0]['sourceSubpaths'],['leaf:0','arc:0'])

    def test_furniture_curve_and_non_circle_are_not_doors(self):
        arc=[[math.cos(t*math.pi/24),2*math.sin(t*math.pi/24)] for t in range(13)]
        e={'paths':[path('leaf','input|vrata',[sub([[0,0],[1,0]])]),path('arc','input|vrata',[sub(arc,curved=True)]),path('chair','input|namjestaj',[sub([[0,0],[1,0]])])]}
        self.assertEqual(m.door_candidates(e),[])

    def test_duplicated_source_door_is_one_opening(self):
        arc=[[math.cos(t*math.pi/24),math.sin(t*math.pi/24)] for t in range(13)]
        e={'paths':[path('leaf','input|vrata',[sub([[0,0],[1,0]])]),path('arc','input|vrata',[sub(arc,curved=True)]),path('arc-copy','input|vrata',[sub(arc,curved=True)])]}
        self.assertEqual(len(m.door_candidates(e)),1)

    def test_glazing_medial_axis_is_measured_and_duplicate_removed(self):
        s=sub([[1,2],[5,2],[5,2.1],[1,2.1]],closed=True)
        e={'paths':[path('glass','input|prozori+balkonska_vrata',[s]),path('copy','input|prozori+balkonska_vrata',[s])]}
        windows=m.window_candidates(e,1)
        self.assertEqual(len(windows),1)
        self.assertAlmostEqual(windows[0]['a'][0],1);self.assertAlmostEqual(windows[0]['a'][1],2.05)
        self.assertAlmostEqual(windows[0]['b'][0],5);self.assertAlmostEqual(windows[0]['b'][1],2.05)

    def test_broad_closed_rectangle_is_not_a_window(self):
        e={'paths':[path('frame','input|prozori+balkonska_vrata',[sub([[0,0],[2,0],[2,1],[0,1]],closed=True)])]}
        self.assertEqual(m.window_candidates(e,1),[])

    def test_floor_network_preserves_exterior_concavity(self):
        ring=[[0,0],[4,0],[4,1],[1,1],[1,4],[0,4]]
        e={'paths':[path('floor','input|tanko+pogled',[sub(ring,closed=True)]),path('furniture','input|namjestaj',[sub([[0,0],[4,0],[4,4],[0,4]],closed=True)])]}
        floor=m.floor_candidate(e,2)
        self.assertEqual(floor.area,7)
        self.assertFalse(floor.covers(m.Polygon([[2,2],[3,2],[3,3],[2,3]])))

    def test_detached_inset_is_not_bridged(self):
        e={'paths':[path('main','input|tanko+pogled',[sub([[0,0],[2,0],[2,2],[0,2]],closed=True)]),path('inset','input|tanko+pogled',[sub([[10,0],[11,0],[11,1],[10,1]],closed=True)])]}
        self.assertEqual(len(m.polygons(m.floor_candidate(e,2))),2)
        self.assertEqual(m.floor_candidate(e,2).area,5)

    def test_source_wall_solids_are_not_replaced_with_outlines(self):
        e={'paths':[path('walls','wall',[sub([[0,0],[3,0],[3,1],[0,1]],closed=True)],'black'),path('outside','wall',[sub([[6,0],[7,0],[7,1],[6,1]],closed=True)],'black')]}
        reading={'wallFillLayers':['wall'],'wallClosedOutlineLayers':[],'excludePathIds':[]}
        walls=m.source_walls(e,reading)
        self.assertEqual(walls.area,4)
        self.assertEqual(len(m.polygons(walls)),2)


    def fixture(self, root, *, overlap=False, voids=None):
        d=root/'example'; d.mkdir()
        walls=[[0,0],[10 if overlap else 4,0],[10 if overlap else 4,1],[0,1]]
        evidence={'paths':[path('walls','wall',[sub(walls,closed=True)],'black')]}
        reading={'wallFillLayers':['wall'],'wallClosedOutlineLayers':[],'excludePathIds':[]}
        original={'architecture':{'wallHeightM':2.7,'slabThicknessM':.2,'landings':[],'railings':[]},'source':{},'provenance':{},'extraction':{}}
        m.write(d/'response.json',{'data':reading});m.write(d/'model.json',original);m.write(d/'evidence.json',evidence)
        cs={'floor':[{'outer':[[0,0],[10,0],[10,10],[0,10]],'holes':[]}],
            'metersPerSourceUnit':1,'floorBasis':'fixture CAD contour','coordinateQuantizationSourceUnits':.01,'maxCoordinateShiftM':.0071,
            'sourceVertices':[[2,0],[3,0],[3,.5],[2,.5]],
            'openings':[{'id':'W0','kind':'window','a':[4,.5],'b':[6,.5],'sourceSubpaths':['glass:0']}]}
        for filename,key in [('response.json','originalResponseSha256'),('model.json','originalModelSha256')]:
            cs[key]=hashlib.sha256((d/filename).read_bytes()).hexdigest()
        m.write(d/'refinement-candidates.json',cs)
        m.write(d/'refinement-response.json',{'model':'test','data':{'schema':'test-audit','code':'example','acceptFloor':True,'voids':voids or [],'stairs':[],
            'rejectOpeningIds':[],'openingKinds':[],'coverage':'test','issues':[]}})
        return d

    def test_apply_keeps_original_and_omits_bad_window_without_cutting_wall(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);d=self.fixture(root,overlap=True)
            originals={f:(d/f).read_bytes() for f in ['response.json','model.json']}
            m.apply(root,'example')
            result=json.loads((d/'model.refined.json').read_text())
            self.assertEqual(result['architecture']['openings'],[])
            self.assertEqual(result['extraction']['refinementOmittedOpenings'][0]['reason'],'source wall overlap')
            self.assertEqual(sum(m.Polygon(p[0],p[1:]).area*100 for p in result['architecture']['walls']),10)
            for f,b in originals.items():self.assertEqual((d/f).read_bytes(),b)

    def test_void_cannot_erase_genuine_wall_material(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);self.fixture(root,voids=[{'kind':'lift','ring':[[2,0],[3,0],[3,.5],[2,.5]]}])
            with self.assertRaisesRegex(ValueError,'genuine source wall'):
                m.apply(root,'example')

    def test_apply_rejects_changed_original_checkpoint(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);d=self.fixture(root)
            (d/'model.json').write_text('{}')
            with self.assertRaisesRegex(ValueError,'Original checkpoint changed'):
                m.apply(root,'example')

    def test_skew_glazing_quad_uses_source_short_edge_midpoints(self):
        e={'paths':[path('pane','input|prozori+balkonska_vrata',[sub([[1,2],[5,2.5],[5.01,2.6],[.99,2.1]],closed=True)])]}
        panes=m.window_candidates(e,1)
        self.assertEqual(len(panes),1)
        self.assertAlmostEqual(panes[0]['a'][0],.995)
        self.assertAlmostEqual(panes[0]['a'][1],2.05)
        self.assertAlmostEqual(panes[0]['b'][0],5.005)
        self.assertAlmostEqual(panes[0]['b'][1],2.55)

    def test_existing_semantic_anchor_ids_do_not_shift_when_new_pane_added(self):
        previous=[{'id':'W0','sourceSubpaths':['first:0']},{'id':'W1','sourceSubpaths':['third:0']}]
        current=[{'id':'W0','sourceSubpaths':['first:0']},{'id':'W1','sourceSubpaths':['new:0']},{'id':'W2','sourceSubpaths':['third:0']}]
        self.assertEqual([o['id'] for o in m.preserve_candidate_ids(previous,current)],['W0','W2','W1'])

    def test_current_issues_exclude_applied_void_and_old_crop_notes_but_raw_audit_survives(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);d=self.fixture(root)
            receipt=json.loads((d/'refinement-response.json').read_text())
            receipt['data']['issues']=["The bottom balcony's distal edge cannot be visually checked in the supplied crop.", 'Lift aperture remains unresolved.']
            m.write(d/'refinement-response.json',receipt)
            m.apply(root,'example')
            result=json.loads((d/'model.refined.json').read_text())
            self.assertNotIn(receipt['data']['issues'][0],result['issues'])
            self.assertIn(receipt['data']['issues'][1],result['issues'])
            self.assertEqual(result['provenance']['semanticAudit']['issues'],receipt['data']['issues'])
            self.assertEqual(json.loads((d/'refinement-response.json').read_text()),receipt)

if __name__=='__main__':unittest.main()
