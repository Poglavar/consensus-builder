"""Headless checks for CAD primitives and stair/opening inference; requires PyMuPDF + Shapely."""
import math
from pathlib import Path
import sys
import tempfile
import unittest
import pymupdf as pdf
from shapely.geometry import LineString, box
from shapely.ops import unary_union
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from pionir_floor_architecture import read_cad, find_stairs, gap_at


class ArchitecturalExtraction(unittest.TestCase):
    def test_zero_area_line_bounds_and_polyline_swings_survive_pdf_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'cad.pdf'
            document = pdf.open()
            page = document.new_page(width=30, height=30)
            page.draw_line((1, 1), (1, 3), color=(.391,)*3, width=.3)
            page.draw_polyline([(5+.8*math.cos(i*math.pi/10), 5+.8*math.sin(i*math.pi/10)) for i in range(6)],
                               color=(.391,)*3, width=.3, closePath=False)
            document.save(path)
            _, _, _, lines, _, arcs, _ = read_cad(path, {'crop':[0,0,20,20], 'page':1}, .391, 1)
            self.assertTrue(any(list(line.coords) == [(1.,1.), (1.,3.)] for line in lines))
            self.assertEqual(len(arcs), 1)
            self.assertEqual(arcs[0]['hinge'], (5.,5.))
            self.assertAlmostEqual(arcs[0]['radius'], .8, places=3)

    def test_nosing_strokes_count_as_one_step_and_pairs_connect_one_storey(self):
        lines = []
        for x in [0, 1.45]:
            for step in range(9):
                for nosing in [0, .025]:
                    y=step*.25+nosing
                    lines.append(LineString([(x,y),(x+1.2,y)]))
        flights, landings, voids=find_stairs(lines,[((.6,0),(.6,2)),((2.05,2),(2.05,0))],3)
        self.assertEqual([flight['steps'] for flight in flights],[9,9])
        self.assertEqual([(flight['fromM'],flight['toM']) for flight in flights],[(0,1.5),(1.5,3)])
        self.assertEqual(len(landings),1)
        self.assertEqual(len(voids),1)
        self.assertGreater(voids[0].area,4)

    def test_single_entrance_flight_does_not_get_an_invented_return(self):
        lines=[LineString([(0,step*.25),(1.2,step*.25)]) for step in range(9)]
        flights,landings,voids=find_stairs(lines,[((.6,0),(.6,2))],3)
        self.assertEqual(len(flights),1)
        self.assertEqual(flights[0]['toM'],1.5)
        self.assertEqual(landings,[])
        self.assertEqual(len(voids),1)

    def test_perpendicular_facade_proximity_does_not_invent_a_wide_window(self):
        outline=box(0,0,20,20)
        def gap(y):
            walls=unary_union([box(0,y-.1,16,y+.1),box(19,y-.1,20,y+.1)])
            return gap_at(walls,(16,y),(16.8,y),outline)
        self.assertIsNone(gap(5.5))
        self.assertTrue(gap(1)['exterior'])


if __name__ == '__main__':
    unittest.main()
