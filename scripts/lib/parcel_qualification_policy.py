"""Shared initial parcel-availability threshold; detailed quality findings remain follow-ups."""
import json
import math
import re
from pathlib import Path

POLICY = json.loads(Path(__file__).with_name('parcel-qualification-policy.json').read_text())
REQUIRED_CHECKS = tuple(POLICY['requiredChecks'])


def initial_qualification_review(checks, failures=None):
    checks, failures = checks or {}, failures or {}
    follow_up = []
    for key in POLICY['followUpChecks']:
        check = checks.get(key) or {}
        if check.get('passed') is not True:
            failure = failures.get(key) or {}
            follow_up.append({'check': key, 'reason': re.sub(r'/(?:Users|home|root|private|tmp|var)/[^\s]+', '<local>', str(check.get('reason') or failure.get('message')
                              or failure.get('error') or 'Not established during initial qualification; investigate in the second pass.'))})
    return {'policy': POLICY['id'], 'passed': all(isinstance(checks.get(key), dict) and checks[key].get('passed') is True for key in REQUIRED_CHECKS),
            'requiredChecks': list(REQUIRED_CHECKS), 'status': 'follow-up-required' if follow_up else 'no-open-findings', 'followUp': follow_up}


def usable_parcel_cache(cache, source_id=None):
    """Require actual, geographically usable polygon output without imposing survey-quality QA."""
    if cache.get('type') != 'FeatureCollection' or not isinstance(cache.get('features'), list) or not cache['features']:
        return False
    usable = False
    for feature in cache['features']:
        properties = feature.get('properties') or {}
        if not (feature.get('id') or properties.get('parcelId') or properties.get('sourceParcelId')):
            return False
        if source_id and properties.get('sourceId') and properties['sourceId'] != source_id:
            return False
        geometry = feature.get('geometry') or {}
        if geometry.get('type') not in {'Polygon', 'MultiPolygon'}:
            return False
        polygons = [geometry.get('coordinates')] if geometry['type'] == 'Polygon' else geometry.get('coordinates')
        if not isinstance(polygons, list) or not polygons:
            return False
        for rings in polygons:
            if not isinstance(rings, list) or not rings:
                return False
            for ring in rings:
                if not isinstance(ring, list) or len(ring) < 4:
                    return False
                if ring[0] != ring[-1]:
                    return False
                for point in ring:
                    if not isinstance(point, list) or len(point) < 2 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in point):
                        return False
                    if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                        return False
            ring = rings[0]
            anchor = ring[0]
            other = next((p for p in ring if p[:2] != anchor[:2]), anchor)
            usable = usable or any((other[0] - anchor[0]) * (p[1] - anchor[1]) != (other[1] - anchor[1]) * (p[0] - anchor[0]) for p in ring)
    return usable
