"""Collect the complete archive and apply saved readings; all output stays private.

Building identities, drawing variants and real floor indices remain separate.
Sources and per-drawing checkpoints make collection restartable without model calls.
"""
import argparse
import hashlib
import importlib.util
import json
import re
import shutil
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from lxml import html

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent / 'logs/stanovanje-plus-archive-20261020'
TRIAL = SCRIPTS.parent / 'logs/stanovanje-plus-ten-20261019'
BASE = 'https://stanovanje.plus/'


def write(file, value):
    temporary = file.with_suffix(file.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2))
    temporary.replace(file)


def read(file):
    return json.loads(file.read_text())


def digest(data):
    return hashlib.sha256(data).hexdigest()


def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def url(href):
    result = urllib.parse.urljoin(BASE, href)
    parsed = urllib.parse.urlparse(result)
    if parsed.scheme != 'https' or parsed.netloc != 'stanovanje.plus':
        raise ValueError('Unexpected archive origin')
    return result.replace('/nacrti.php?', '/2026nacrti.php?').replace('/info.php?', '/2026info.php?')


def inventory(raw):
    buildings, plans = [], []
    for row in html.fromstring(raw).xpath('//tr[td]'):
        cells = row.xpath('./td')
        links = row.xpath('.//a/@href')
        infos = [a for a in links if 'info.php?' in a]
        if len(cells) < 3 or not infos:
            continue
        code = urllib.parse.parse_qs(urllib.parse.urlparse(infos[0]).query)['code'][0]
        if not re.fullmatch('[a-z0-9]+', code):
            raise ValueError('Invalid building code')
        building = dict(code=code, title=cells[0].text_content().strip(),
                        author=cells[1].text_content().strip(), city=cells[2].text_content().strip(),
                        infoUrl=url(infos[0]), drawings=[])
        for a in links:
            if 'nacrti.php?' not in a:
                continue
            drawing = urllib.parse.parse_qs(urllib.parse.urlparse(a).query)['nc'][0]
            if not re.fullmatch('[a-z0-9-]+', drawing):
                raise ValueError('Invalid drawing code')
            is_floor = drawing.startswith('tl-') and drawing != 'tl-instalacije'
            building['drawings'].append(dict(drawingId=drawing, sourceUrl=url(a), floorPlan=is_floor))
            if is_floor:
                # Keep the original ten task identities; the source unit ID always names its variant.
                key = code if drawing == 'tl-kk1' else code + '-' + drawing
                plans.append(dict(code=key, buildingCode=code, drawingId=drawing, unitId=code+'-'+drawing,
                                  title=building['title'], author=building['author'], city=building['city'],
                                  infoUrl=building['infoUrl'], sourceUrl=url(a), planLabel=drawing,
                                  registration=None))
        buildings.append(building)
    if len({b['code'] for b in buildings}) != len(buildings) or len({p['code'] for p in plans}) != len(plans):
        raise ValueError('Duplicate archive identity')
    return buildings, plans


def fetch(target):
    request = urllib.request.Request(target, headers={'User-Agent': 'FloorPlanResearch/1.0'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(64_000_001)
    if len(data) > 64_000_000:
        raise ValueError('Source exceeds 64 MB')
    return data


def svg_bytes(raw):
    match = re.search(rb'<svg\b[\s\S]*?</svg>', raw)
    if not match:
        raise ValueError('Archive drawing has no SVG')
    return match[0]


def building_evidence(building, raw):
    fields = {}
    for row in html.fromstring(raw).xpath('//tr'):
        cells = row.xpath('./td|./th')
        if len(cells) == 2:
            fields[' '.join(cells[0].text_content().split())] = ' '.join(cells[1].text_content().split())
    def count(label):
        value = fields.get(label, '')
        return int(value) if re.fullmatch(r'\d+', value) else None
    return dict(schema='stanovanje-plus.building-evidence.v1', code=building['code'],
                source=dict(url=building['infoUrl'], metadataSha256=digest(raw),
                            basis='Archive metadata claims; not independent survey measurements'),
                aboveGroundCount=count('Broj nadzemnih etaža'), belowGroundCount=count('Broj podzemnih etaža'),
                fields=fields, storeyHeights=[], drawings=building['drawings'])


def collect(root):
    root.mkdir(parents=True, exist_ok=True)
    rules = root / 'robots.json'
    if not rules.exists():
        try:
            text = fetch(BASE+'robots.txt').decode()
            policy = dict(status=200, text=text)
        except urllib.error.HTTPError as error:
            if error.code not in (404, 410):
                raise
            policy = dict(status=error.code, text='')
        write(rules, policy)
    policy = read(rules)
    robot = urllib.robotparser.RobotFileParser()
    robot.parse(policy['text'].splitlines())
    def allowed(target):
        if policy['status'] == 200 and not robot.can_fetch('FloorPlanResearch', target):
            raise ValueError('Crawl rules exclude '+target)
    index = root / 'index.html'
    if not index.exists():
        allowed(BASE+'nacrtitab.php')
        index.write_bytes(fetch(BASE+'nacrtitab.php'))
    buildings, plans = inventory(index.read_bytes())
    write(root/'buildings.json', buildings)
    by_drawing = {(p['buildingCode'], p['drawingId']): p for p in plans}
    started = time.monotonic()

    def one(building):
        directory = root/'buildings'/building['code']
        directory.mkdir(parents=True, exist_ok=True)
        result = dict(code=building['code'], drawings=len(building['drawings']), retained=0, reused=0, errors=[])
        try:
            info = directory/'info.html'
            if not info.exists():
                allowed(building['infoUrl']); info.write_bytes(fetch(building['infoUrl']))
            evidence = building_evidence(building, info.read_bytes())
            write(directory/'building-evidence.json', evidence)
        except Exception as error:
            result['errors'].append(dict(stage='metadata', error=str(error)))
            evidence = None
        for drawing in building['drawings']:
            try:
                target = directory/(drawing['drawingId']+'.svg')
                plan = by_drawing.get((building['code'], drawing['drawingId']))
                trial = TRIAL/building['code']
                prior = trial/'source.svg' if drawing['drawingId']=='tl-kk1' else trial/'building-sources'/(drawing['drawingId']+'.svg')
                if not target.exists():
                    if prior.exists():
                        shutil.copyfile(prior, target); result['reused'] += 1
                    else:
                        allowed(drawing['sourceUrl']); target.write_bytes(svg_bytes(fetch(drawing['sourceUrl'])))
                raw = target.read_bytes()
                if not raw.startswith(b'<svg'):
                    raise ValueError('Invalid saved SVG')
                result['retained'] += 1
                if plan:
                    folder = root/plan['code']
                    if not folder.exists() and drawing['drawingId']=='tl-kk1' and (trial/'source.svg').exists() and digest((trial/'source.svg').read_bytes())==digest(raw):
                        shutil.copytree(trial, folder)
                    folder.mkdir(exist_ok=True)
                    plan.update(sourceSha256=digest(raw), bytes=len(raw))
                    if not (folder/'source.svg').exists():
                        shutil.copyfile(target, folder/'source.svg')
                    if digest((folder/'source.svg').read_bytes()) != plan['sourceSha256']:
                        raise ValueError('Saved reading source changed; preserve checkpoints for explicit review')
                    write(folder/'source.json', plan)
                    if evidence and not (folder/'building-evidence.json').exists():
                        write(folder/'building-evidence.json', evidence)
            except Exception as error:
                result['errors'].append(dict(drawing=drawing['drawingId'], error=str(error)))
        write(directory/'collection.json', result)
        return result

    results = []
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(one, b) for b in buildings]
        for future in as_completed(futures):
            result = future.result(); results.append(result)
            write(root/'selection.json', plans)
            write(root/'collection-results.json', results)
            elapsed = time.monotonic()-started
            print(time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), f'{len(results)}/{len(buildings)} buildings',
                  result['code'], f'{result["retained"]}/{result["drawings"]} drawings',
                  f'{len(result["errors"])} errors', f'ETA {elapsed/len(results)*(len(buildings)-len(results)):.0f}s', flush=True)
    summary = dict(buildings=len(buildings), buildingsWithFloorPlans=len({p['buildingCode'] for p in plans}),
                   floorPlans=len(plans), ready=sum('sourceSha256' in p for p in plans),
                   drawings=sum(r['drawings'] for r in results), retained=sum(r['retained'] for r in results),
                   errors=sum(len(r['errors']) for r in results), private=True)
    write(root/'collection-summary.json', summary)
    print(json.dumps(summary), flush=True)


def local(root, action, codes):
    sources = {p['code']: p for p in read(root/'selection.json')}
    for code in codes:
        if code not in sources:
            raise ValueError('Drawing outside archive selection')
        directory = root/code
        if action == 'evidence':
            if not (directory/'evidence.json').exists():
                evidence = module('stanovanje-plus-evidence').collect((directory/'source.svg').read_bytes())
                write(directory/'evidence.json', evidence)
                write(directory/'layer-summary.json', {k:evidence[k] for k in ['viewBox','layers']})
        elif action == 'build':
            if not (directory/'model.json').exists():
                receipt = read(directory/'response.json')
                model = module('stanovanje-plus-build').compile_model(sources[code], read(directory/'evidence.json'), receipt['data'])
                model['accounting'] = {k:receipt.get(k) for k in ['model','usage','equivalentUsd','costUsd','ms']}
                model['provenance'].update(model=receipt['model'], effort='medium', processor='stanovanje-plus-archive-v1')
                write(directory/'model.json', model)
        else:
            module('stanovanje-plus-refine').__dict__[action](root, code)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['collect','evidence','build','prepare','apply'])
    parser.add_argument('codes', nargs='*')
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    if args.action == 'collect':
        collect(args.root.resolve())
    else:
        local(args.root.resolve(), args.action, args.codes)
