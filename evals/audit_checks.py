"""Offline checks and independent route validity checks for the audit."""
from __future__ import annotations
import copy
import json
import math
from collections import Counter
from pathlib import Path
import random
import re
import networkx as nx
from shapely.geometry import Polygon
from evals.audit import dump, read, score, KINDS
from evals.audit_synthetic import Oracle, reference_class, questions, shoelace, centroid, render_svg


def engine_reply(item):
    # Production imports are intentionally confined to the system-under-test adapter.
    from navcore.engine import Building, Constraints, EngineError
    from navagent.tools import Session
    from tests.test_dataset import call_tools_like_the_agent
    s=Session(Building.load(Path(item['building_path'])))
    if item['kind'] in KINDS:
        call_tools_like_the_agent(s,item)
    else:
        inp=item['inputs'];constraints=Constraints(step_free=inp['step_free'],closed=frozenset(inp['closed']))
        try:
            route=s.building.route(inp['start'],inp['end'],constraints)
            s.submit_answer('number',route.length_m)
        except EngineError:s.submit_answer('text',text='No route exists.')
    return s.answer_line()


def check_development(run):
    rows=[]
    for item in read(run/'development_all_cases.json'):
        try:reply=engine_reply(item);error=None
        except Exception as exc:reply='';error=f'{type(exc).__name__}: {exc}'
        rows.append({'id':item['id'],'kind':item['kind'],'building_id':item['building_id'],
                     'source':item['source'],'correct':score(item,reply),'reply':reply,'error':error})
    with (run/'synthetic_engine.jsonl').open('w') as f:
        for r in rows:f.write(json.dumps(r)+'\n')
    print('Synthetic engine:',sum(x['correct'] for x in rows),'/',len(rows))
    print('Failures:',[(x['id'],x['error'],x['reply']) for x in rows if not x['correct']])
    return rows


def transformed(data,meta,mode):
    data=copy.deepcopy(data);meta=copy.deepcopy(meta)
    if mode=='shuffle':
        rng=random.Random(819)
        for key in ('spaces','floors','openings','assets','vertical_connectors'):rng.shuffle(data[key])
    elif mode=='translate':
        dx,dy=123.25,-80.5
        for s in data['spaces']:s['polygon']=[[x+dx,y+dy] for x,y in s['polygon']]
        for s in data['openings']+data['assets']:s['position']=[s['position'][0]+dx,s['position'][1]+dy]
        meta['new_door']['position']=[meta['new_door']['position'][0]+dx,meta['new_door']['position'][1]+dy]
    elif mode=='rename':
        mapping={x['id']:f'opaque-{i}-{k}' for k in ('spaces','floors','openings','assets','vertical_connectors')
                 for i,x in enumerate(data[k])}
        def replace(v):
            if isinstance(v,dict):return {k:replace(x) for k,x in v.items()}
            if isinstance(v,list):return [replace(x) for x in v]
            return mapping.get(v,v) if isinstance(v,str) else v
        data=replace(data);meta=replace(meta)
    return data,meta


def check_transforms(run):
    router=reference_class(run);rows=[]
    # Eight independently generated layouts, three transformations, twelve capabilities.
    for i,record in enumerate(read(run/'development_buildings.json')[:8]):
        p=Path(record['path']);data=read(p/'building.json');meta=read(p/'generation.json')
        originals=questions(data,meta,router,i)
        for mode in ('shuffle','translate','rename'):
            d,m=transformed(data,meta,mode);dest=run/'transformed'/mode/record['building_id']
            dump(dest/'building.json',d)
            changed=questions(d,m,router,i)
            for old,new in zip(originals,changed,strict=True):
                # Numeric tolerances follow explicit grader limits; identity follows labels after renaming.
                comparable=old['answer'].get('value');v=new['answer'].get('value')
                invariant=(abs(comparable-v)<.05 if comparable is not None else
                           old['answer'].get('accept')==new['answer'].get('accept'))
                new['building_path']=str(dest)
                try:reply=engine_reply(new);ok=score(new,reply);error=None
                except Exception as exc:reply='';ok=False;error=str(exc)
                rows.append({'id':new['id']+'-'+mode,'kind':new['kind'],'source':mode,
                    'building_id':record['building_id'],'correct':bool(ok and invariant),
                    'oracle_invariant':invariant,'reply':reply,'error':error})
    with (run/'transform_checks.jsonl').open('w') as f:
        for row in rows:f.write(json.dumps(row)+'\n')
    print('Transform checks:',sum(x['correct'] for x in rows),'/',len(rows))
    return rows


def validate_route(run,item,row):
    """Check every emitted route element against constraints and endpoint requirements.

    Numeric-answer accuracy and route feasibility are separate checks. A claimed path
    must correspond to the pinned reference graph, including intermediate spaces.
    """
    if not item['kind'].startswith('route'):return None
    inp=item['inputs'];oracle=Oracle(read(Path(item['building_path'])/'building.json'),reference_class(run))
    graph=oracle.graph(step=inp['step_free'],closed=inp['closed'])
    reachable=inp['end'] in oracle.distances(inp['start'],step=inp['step_free'],closed=inp['closed'])
    text=row.get('reply','');match=re.search(r'^Route: .*?\| spaces: (.*?) \| doors and stairs: (.*)$',text,re.M)
    if not reachable:return {'valid':score(item,text),'reason':'unreachable, must not claim route'}
    if not match:return {'valid':False,'reason':'reachable route missing Route: evidence'}
    spaces=match[1].split(', ');elements=match[2].split(', ')
    if spaces[0]!=inp['start'] or spaces[-1]!=inp['end']:
        return {'valid':False,'reason':'wrong endpoint'}
    doors={x['id']:x for x in oracle.data['openings']}
    connectors={x['id']:x for x in oracle.data['vertical_connectors']}
    positions=[inp['start']]
    # Reconstruct compressed space transitions from the emitted openings/connectors.
    current=inp['start'];walk_spaces=[current]
    for element in elements:
        if element in inp['closed']:return {'valid':False,'reason':'closed element used'}
        if element in doors:
            o=doors[element]
            if inp['step_free'] and not o['step_free']:return {'valid':False,'reason':'steps used'}
            if current not in o['space_ids']:return {'valid':False,'reason':'noncontiguous door'}
            following=next(s for s in o['space_ids'] if s!=current)
            if following=='outside':return {'valid':False,'reason':'outdoor shortcut'}
        elif element in connectors:
            c=connectors[element]
            if inp['step_free'] and c['kind']=='stairs':return {'valid':False,'reason':'stairs used'}
            idx=len(walk_spaces)
            if idx>=len(spaces):return {'valid':False,'reason':'missing connector stop'}
            following=spaces[idx]
            if not graph.has_edge(current,following) or not any(e.get('via')==element for e in graph[current][following].values()):
                return {'valid':False,'reason':'invalid connector edge'}
        else:return {'valid':False,'reason':'unknown route element'}
        current=following;walk_spaces.append(current)
    return {'valid':walk_spaces==spaces,'reason':'path continuity and constraints'}


def check_routes(run,phase):
    rows=[json.loads(x) for x in (run/f'{phase}.jsonl').read_text().splitlines()]
    items={x['id']:x for x in read(run/'final_cases.json')}
    checks=[]
    for row in rows:
        outcome=validate_route(run,items[row['id']],row)
        if outcome is not None:checks.append({'id':row['id'],**outcome})
    dump(run/f'{phase}_route_validity.json',checks)
    print(phase,'valid routes',sum(x['valid'] for x in checks),'/',len(checks))
    return checks


def check_imports(run):
    from navcore.plans import import_plans
    rows=[]
    # Includes concave, multi-core, shifted floors, and industrial plans, with no JSON input to importer.
    records=read(run/'development_buildings.json')
    for index in (1,2,5,7):
        record=records[index];path=Path(record['path']);truth=read(path/'building.json')
        out=run/'plan_imports'/record['building_id'];out.mkdir(parents=True,exist_ok=True)
        files=[]
        for f in sorted(path.glob('floor_*.svg')):
            target=out/f.name;target.write_bytes(f.read_bytes());files.append(target)
        imported,notes=import_plans(files,building_id='import-'+record['building_id'])
        dump(out/'reconstructed.json',imported)
        # Polygon shape match up to one translation per floor. Cross-floor alignment scored separately.
        source_floors={f['level']:f['id'] for f in truth['floors']};floor_offsets={};matched=0;count=0;mapping={}
        for f in imported['floors']:
            a=[s for s in truth['spaces'] if s['floor_id']==source_floors[f['level']]]
            b=[s for s in imported['spaces'] if s['floor_id']==f['id']]
            tx=min(x for s in a for x,y in s['polygon']);ty=min(y for s in a for x,y in s['polygon'])
            ix=min(x for s in b for x,y in s['polygon']);iy=min(y for s in b for x,y in s['polygon'])
            dx,dy=tx-ix,ty-iy;floor_offsets[f['level']]=[dx,dy]
            for s in a:
                shape=Polygon(s['polygon']);count+=1
                options=[(shape.intersection(p:=Polygon([[x+dx,y+dy] for x,y in other['polygon']])).area/shape.union(p).area,other) for other in b]
                iou,other=max(options,key=lambda v:v[0])
                if iou>=.9:matched+=1;mapping[s['id']]=other['id']
        expected={frozenset(mapping.get(s,s) for s in o['space_ids']) for o in truth['openings']}
        actual={frozenset(o['space_ids']) for o in imported['openings']}
        def links(d,mapping=None):
            floors={f['id']:f['level'] for f in d['floors']};result=set()
            for c in d['vertical_connectors']:
                stops=sorted(zip(c['floor_ids'],c['space_ids']),key=lambda t:floors[t[0]])
                for a,b in zip(stops,stops[1:]):result.add((c['kind'],frozenset((mapping.get(a[1],a[1]),mapping.get(b[1],b[1]))) if mapping is not None else frozenset((a[1],b[1]))))
            return result
        want=links(truth,mapping);got=links(imported)
        offsets=list(floor_offsets.values());aligned=all(math.dist(offsets[0],x)<.1 for x in offsets)
        rows.append({'building':record['building_id'],'family':record['family'],'rooms_matched':matched,'rooms_total':count,
          'opening_pairs_correct':len(expected&actual),'opening_pairs_total':len(expected),
          'connector_flights_correct':len(want&got),'connector_flights_total':len(want),'aligned':aligned,
          'assumptions':notes,'supplied_metadata':'SVG only; no truth heights or door widths supplied'})
    dump(run/'plan_imports.json',rows)
    print('Plan imports:',json.dumps(rows,indent=2));return rows
