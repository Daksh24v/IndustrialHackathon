"""Independent building generator and oracle for the judge audit.

No navcore/navagent imports. Routing uses the frozen organizer implementation;
geometry and question selection are evaluated directly on the generated schema.
"""
from __future__ import annotations
import copy
import hashlib
import importlib.util
import itertools
import json
import math
from pathlib import Path
import random
import secrets
import sys
from xml.sax.saxutils import escape

import networkx as nx
from shapely.geometry import Polygon, LineString
from shapely.ops import linemerge

from evals.audit import KINDS, ROOT, dump, read, digest, source_hash

FAMILIES=('long_corridor','concave_wing','multiple_cores','disconnected','basement',
          'offset_floors','width_bottleneck','industrial')
COLORS={'room':'#f3efe6','corridor':'#dcdcdc','hall':'#fff2b3','stair':'#f4b183','lift':'#b4a7d6'}

def rect(x,y,w,h):return [[x,y],[x+w,y],[x+w,y+h],[x,y+h]]

def shoelace(points):
    return abs(sum(a[0]*b[1]-b[0]*a[1] for a,b in zip(points,points[1:]+points[:1])))/2

def centroid(points):
    pairs=list(zip(points,points[1:]+points[:1]))
    cross=[a[0]*b[1]-b[0]*a[1] for a,b in pairs]
    area2=sum(cross)
    return tuple(sum((a[i]+b[i])*c for (a,b),c in zip(pairs,cross))/(3*area2) for i in (0,1))

def reference_class(run):
    path=run/'reference_router.py'
    assert digest(path)==read(run/'manifest.json')['reference_router_sha256']
    name='_audit_pinned_router'
    if name not in sys.modules:
        spec=importlib.util.spec_from_file_location(name,path)
        module=importlib.util.module_from_spec(spec);sys.modules[name]=module;spec.loader.exec_module(module)
    return sys.modules[name].BuildingMap

def building(seed,family,index):
    rng=random.Random(seed);bid=f'audit-{family}-{seed:x}'
    data={'building':{'id':bid,'name':f'{family.replace("_"," ").title()} {index}',
          'source':'audit_synthetic','license':'CC0-1.0','units':'m'},
          'floors':[],'spaces':[],'openings':[],'vertical_connectors':[],'assets':[]}
    meta={'family':family,'levels':{},'new_door':None,'width':rng.choice([.9,1.1,1.2]),'seed':seed}
    n=rng.choice([2,3,4]);levels=list(range(-1,n-1)) if family=='basement' else list(range(n))
    widths=[rng.uniform(5,9),rng.uniform(10,14),rng.uniform(6,9),rng.uniform(7,11)]
    xs=[0.]
    for w in widths:xs.append(xs[-1]+w)
    length=xs[-1]*(1.5 if family=='long_corridor' else 1.)
    if family=='long_corridor':xs=[x*1.5 for x in xs];widths=[w*1.5 for w in widths]
    h=rng.uniform(5,8);corridor_h=rng.uniform(2.2,3.2)
    def new_id(prefix):return f'{bid}-{prefix}-{rng.getrandbits(32):08x}'
    def space(fid,level,number,kind,typ,points):
        sid=new_id('s');ref=f'{level}.{number:02d}'
        label=typ.replace('_',' ').capitalize()
        data['spaces'].append({'id':sid,'floor_id':fid,'type':kind,'room_type':typ,
           'name':f'{label} {ref}','ref':ref,'polygon':points,'synthetic':True})
        return sid
    def door(fid,a,b,pos,width=1.6,step=True,kind='door'):
        oid=new_id('o');data['openings'].append({'id':oid,'floor_id':fid,'space_ids':[a,b],
             'position':pos,'kind':kind,'width_m':width,'step_free':step,'synthetic':True});return oid
    elevation=0.
    for floor_index,level in enumerate(levels):
        fid=new_id('f')
        if floor_index: elevation+=rng.choice([2.8,3.8,5.2,7.]) if family in ('basement','industrial') else 3.8
        data['floors'].append({'id':fid,'level':level,'name':'Ground floor' if level==0 else f'Floor {level}',
                               'elevation_m':round(elevation,4),'height_m':3.8})
        cut=list(xs)
        if family=='offset_floors' and floor_index%2:
            cut[1]+=widths[1]*.3;cut[2]+=widths[2]*.35
        cpoly=rect(0,h,length,corridor_h)
        if family=='concave_wing':
            cpoly=[[0,h],[length,h],[length,h+corridor_h],[length-4,h+corridor_h],
                   [length-4,h+corridor_h+8],[length-7,h+corridor_h+8],
                   [length-7,h+corridor_h],[0,h+corridor_h]]
        c=space(fid,level,0,'hall' if family=='industrial' else 'corridor',
                'lobby' if family=='industrial' else 'corridor',cpoly)
        rooms=[]
        for j in range(4):
            poly=rect(cut[j],0,cut[j+1]-cut[j],h)
            if family=='concave_wing' and j==1:
                x=cut[j];w=cut[j+1]-x
                poly=[[x,0],[x+w,0],[x+w,h],[x,h],[x,h*.5],[x+w*.25,h*.5],[x+w*.25,h*.25],[x,h*.25]]
            sid=space(fid,level,j+1,'room',['office','office','meeting_room','lab'][j],poly);rooms.append(sid)
            width=meta['width']+([-0.001,0,0.001,.5][j]) if family=='width_bottleneck' else rng.choice([.9,1.1,1.2,1.6])
            door(fid,c,sid,[(cut[j]+cut[j+1])/2,h],round(width,3))
            if family=='long_corridor' and j==1:
                door(fid,c,sid,[cut[j]+.7,h],.8)
        # Shafts join spaces, not arbitrary floor numbers. All plans share their coordinates.
        lift=space(fid,level,10,'lift','lift',rect(0,h+corridor_h,3,3))
        stair=space(fid,level,11,'stair','stairwell',rect(length-3,h+corridor_h,3,3))
        door(fid,c,lift,[1.5,h+corridor_h],1.6)
        door(fid,c,stair,[length-1.5,h+corridor_h],1.6)
        record={'floor':fid,'corridor':c,'rooms':rooms,'lift':lift,'stairs':stair}
        if family=='multiple_cores':
            second=space(fid,level,12,'lift','lift',rect(length/2-1.5,h+corridor_h,3,3))
            door(fid,c,second,[length/2,h+corridor_h],1.6);record['second_lift']=second
        if floor_index==0:
            lobby=space(fid,level,20,'corridor','corridor',rect(0,-3,length,3));record['exit_lobby']=lobby
            door(fid,'outside',lobby,[0,-1.5],1.8,True,'entrance')
            door(fid,lobby,rooms[-1],[(cut[3]+cut[4])/2,0],1.6)
            meta['new_door']={'first':lobby,'second':rooms[0],'position':[(cut[0]+cut[1])/2,0]}
        if family=='disconnected':
            isolated=space(fid,level,30,'room','storage',rect(length+8,0,7,5));record['isolated']=isolated
            if floor_index==0:door(fid,'outside',isolated,[length+8,2.5],1.6,True,'entrance')
        for j in (0,3):
            sid=rooms[j];poly=Polygon(next(s['polygon'] for s in data['spaces'] if s['id']==sid))
            point=poly.representative_point()
            data['assets'].append({'id':new_id('a'),'name':f'Drill {level}.{j+1:02d}',
                'category':'machine','type':'drill','space_id':sid,'floor_id':fid,'position':[point.x,point.y],
                'footprint':{'width_m':.5,'depth_m':.5,'rotation_deg':0},'source':'generated'})
        # Distracting furniture density should not predict room area.
        for k in range(7 if family=='industrial' else 2):
            sid=rooms[0];p=Polygon(next(s['polygon'] for s in data['spaces'] if s['id']==sid)).representative_point()
            data['assets'].append({'id':new_id('a'),'name':f'Chair {level}-{k}','category':'furniture','type':'chair',
                'space_id':sid,'floor_id':fid,'position':[p.x,p.y],
                'footprint':{'width_m':.4,'depth_m':.4,'rotation_deg':0},'source':'generated'})
        meta['levels'][str(level)]=record
    records=list(meta['levels'].values())
    for key,kind,name in [('lift','lift','West lift'),('stairs','stairs','East stairs')]+(
             [('second_lift','lift','Middle lift')] if family=='multiple_cores' else []):
        cid=new_id('v');data['vertical_connectors'].append({'id':cid,'kind':kind,'name':name,
           'floor_ids':[r['floor'] for r in records],'space_ids':[r[key] for r in records],
           'step_free':kind=='lift','synthetic':True})
        meta[key+'_connector']=cid
    # Random offsets and opaque ids prevent reliance on origin, record order or kit naming.
    dx,dy=rng.uniform(-500,500),rng.uniform(-500,500)
    for s in data['spaces']:s['polygon']=[[round(x+dx,6),round(y+dy,6)] for x,y in s['polygon']]
    for item in data['openings']+data['assets']:
        x,y=item['position'];item['position']=[round(x+dx,6),round(y+dy,6)]
    x,y=meta['new_door']['position'];meta['new_door']['position']=[round(x+dx,6),round(y+dy,6)]
    for key in ('spaces','openings','assets','floors','vertical_connectors'):rng.shuffle(data[key])
    return data,meta

class Oracle:
    def __init__(self,data,router):
        self.data=data;self.router=router;self.spaces={s['id']:s for s in data['spaces']}
        self.floors={f['id']:f for f in data['floors']};self.poly={s['id']:Polygon(s['polygon']) for s in data['spaces']}
        assert all(p.is_valid and p.area>0 for p in self.poly.values())
        assert all(abs(p.area-shoelace(self.spaces[s]['polygon']))<1e-6 for s,p in self.poly.items())
    def label(self,s):return f'{self.spaces[s]["name"]} ({self.floors[self.spaces[s]["floor_id"]]["name"]})'
    def graph(self,step=False,width=0,closed=(),extra=None):
        d=copy.deepcopy(self.data)
        if extra:d['openings'].append(extra)
        bm=self.router(d)
        bm.closed=set(closed)|{o['id'] for o in d['openings'] if o['width_m']<width-1e-9}
        return bm.graph(step)
    def distances(self,start,**kw):
        g=self.graph(**kw)
        return nx.single_source_dijkstra_path_length(g,start,weight='weight') if start in g else {}
    def length(self,a,b,**kw):return self.distances(a,**kw).get(b)
    def exits(self,extra=None):
        g=self.graph(extra=extra);doors=['door:'+o['id'] for o in self.data['openings'] if 'outside' in o['space_ids']]
        return nx.multi_source_dijkstra_path_length(g,doors,weight='weight')
    def rooms(self,floor,typ=None):
        return [s['id'] for s in self.spaces.values() if s['floor_id']==floor and s['type']=='room'
                and (typ is None or s['room_type']==typ)]
    def largest(self,floor,typ):
        ids=sorted(self.rooms(floor,typ),key=lambda s:shoelace(self.spaces[s]['polygon']),reverse=True)
        if len(ids)>1 and abs(self.poly[ids[0]].area-self.poly[ids[1]].area)<1e-4:raise ValueError('tied largest')
        return ids[0]
    def stacked(self,start,direction):
        level=self.floors[self.spaces[start]['floor_id']]['level']
        fs=sorted(self.floors.values(),key=lambda f:f['level'])
        nexts=[f for f in fs if f['level']>level] if direction=='above' else [f for f in fs if f['level']<level][::-1]
        if not nexts:return None
        candidates=sorted([(self.poly[start].intersection(self.poly[s]).area,s) for s in self.spaces
              if self.spaces[s]['floor_id']==nexts[0]['id']],reverse=True)
        if not candidates or candidates[0][0]<=0:return None
        if len(candidates)>1 and abs(candidates[0][0]-candidates[1][0])<1e-6:raise ValueError('ambiguous overlap')
        return candidates[0][1]
    def walls(self,start,min_length=1.,tolerance=.35):
        # Implements the README boundary-within-distance definition directly.
        a=self.poly[start].exterior
        return [s for s,p in self.poly.items() if s!=start and self.spaces[s]['floor_id']==self.spaces[start]['floor_id']
            and self.spaces[s]['type'] in ('room','hall')
            and a.intersection(p.exterior.buffer(tolerance)).length>=min_length]
    def what_if(self,meta,floor):
        edit=meta['new_door'];before=self.exits()
        extra={'id':'audit-new-door','floor_id':self.spaces[edit['first']]['floor_id'],
            'space_ids':[edit['first'],edit['second']],'position':edit['position'],
            'width_m':.9,'step_free':True,'kind':'door','synthetic':True}
        after=self.exits(extra=extra)
        return sum(before.get(s,math.inf)-after[s]>1. for s in self.rooms(floor) if s in after)

def number(value,rel=0.,absolute=0.):
    return {'type':'number','value':value,'relative_tolerance':rel,'absolute_tolerance':absolute}

def room_answer(oracle,sid,include_area=False):
    s=oracle.spaces[sid]
    a={'type':'space','space_id':sid,'accept':[s['name'],s['ref']],
       'reject':[x['name'] for x in oracle.spaces.values() if x['id']!=sid]}
    if include_area:a['area']=number(shoelace(s['polygon']),.05)
    return a

def questions(data,meta,router,variant=0):
    o=Oracle(data,router);records=list(meta['levels'].values());low=records[0];upper=records[-1]
    floor=upper['floor'];fn=o.floors[floor]['name'];bid=data['building']['id'];items=[]
    def add(kind,text,answer,inputs):
        suffix="Finish with a line 'Answer: <room name or number>"+(", <area> m²'." if 'area' in answer else "'.") if answer.get('type')=='space' else "Finish with a line 'Answer: <number>'."
        if answer.get('reachable') is False:suffix="Finish with the line 'Answer: No route exists.'"
        items.append({'id':f'{bid}-{kind}','building_id':bid,'kind':kind,'question':text+' '+suffix,
                      'answer':answer,'inputs':inputs,'source':meta['family'],'cohort':'synthetic'})
    biggest=o.largest(floor,'office')
    add('largest_room',f'Which office on {fn} has the greatest floor area, and what is its area in square metres?',
        room_answer(o,biggest,True),{'floor_id':floor,'room_type':'office'})
    add('floor_area_total',f'Add the floor areas of all offices on {fn}. What is the total in square metres?',
        number(sum(shoelace(o.spaces[s]['polygon']) for s in o.rooms(floor,'office')),.05),{'floor_id':floor,'room_type':'office'})
    start=low['rooms'][2];target=o.largest(floor,'meeting_room');step=bool(variant%2)
    dist=o.distances(start,step=step)
    pickup_spaces={a['space_id'] for a in data['assets'] if a['type']=='drill'}
    choices=sorted((dist[s],s) for s in pickup_spaces if s in dist)
    if len(choices)>1 and abs(choices[0][0]-choices[1][0])<1e-5:raise ValueError('ambiguous pickup')
    pickup=choices[0][1];total=choices[0][0]+o.length(pickup,target,step=step)
    carry="I cannot carry it on stairs, but lifts are fine." if step else "I can carry it on stairs."
    add('errand',f'From {o.label(start)}, collect a drill from whichever room containing one has the shortest walk from me, '
        f'then take it to the largest meeting room on {fn}. {carry} How many metres is the complete walk?',
        number(total,.01,1.),{'start':start,'asset_type':'drill','floor_id':floor,'room_type':'meeting_room'})
    entrance=low['exit_lobby'];width=meta['width'];reach=o.distances(entrance,step=True,width=width)
    add('wide_delivery_count',f'A {width} m wide trolley arrives through the entrance into {o.label(entrance)}. '
        f'It cannot use stairs or steps; lifts are fine. Every door must be at least {width} m wide. '
        f'How many rooms on {fn} can it reach? Exclude corridors, halls, stairs and lifts.',
        number(sum(s in reach for s in o.rooms(floor))),{'start':entrance,'floor_id':floor,'min_width':width})
    closed=meta['lift_connector'];reach=o.distances(entrance,step=True,closed=[closed])
    add('step_free_reachable_count',f'The West lift is out of service. A wheelchair user enters {o.label(entrance)}. '
        f'How many rooms on {fn} remain reachable without stairs or steps? Exclude halls, corridors, stairs and lifts.',
        number(sum(s in reach for s in o.rooms(floor))),{'start':entrance,'floor_id':floor,'closed':closed})
    start=records[-1]['rooms'][1] if variant%2 else low['rooms'][1];direction='below' if variant%2 else 'above'
    stacked=o.stacked(start,direction)
    add('room_stacked',f'Which space on the next floor {direction} {o.label(start)} covers the largest part of its footprint?',
        room_answer(o,stacked),{'start':start,'direction':direction})
    s=upper['rooms'][1]
    add('shared_walls_count',f'How many other rooms on the same floor share a wall with {o.label(s)}? '
        'A shared wall means at least 1 m of outline within 0.35 m of the other outline, with or without a door. '
        'Exclude corridors, stairwells and lifts.',number(len(o.walls(s))),{'start':s})
    a=low['rooms'][0];b=upper['rooms'][3]
    def c3(s):return (*centroid(o.spaces[s]['polygon']),o.floors[o.spaces[s]['floor_id']]['elevation_m'])
    add('straight_line_3d',f'What is the straight-line 3D distance in metres between the floor-plan centroids of '
        f'{o.label(a)} and {o.label(b)}, each at its floor elevation?',number(math.dist(c3(a),c3(b)),.02),{'first':a,'second':b})
    edit=meta['new_door']
    add('what_if_door',f'Add a door in the middle of the shared wall between {o.label(edit["first"])} and '
        f'{o.label(edit["second"])}. How many rooms on {fn} would have a walk to their nearest entrance '
        'shorter by more than 1 m? Use the building route model, excluding halls, corridors, stairs and lifts from the count.',
        number(o.what_if(meta,floor)),{'first':edit['first'],'second':edit['second'],'floor_id':floor})
    # Direct route cases: normal, constrained closure, and an explicitly disconnected destination.
    route_cases=[('route',low['rooms'][0],upper['rooms'][3],False,[]),
                 ('route_step_free',low['rooms'][0],upper['rooms'][3],True,[closed]),
                 ('route_disconnected',low['rooms'][0],low.get('isolated',upper['rooms'][0]),True,
                    [] if low.get('isolated') else [c['id'] for c in data['vertical_connectors'] if c['kind']=='lift'])]
    for kind,a,b,sf,avoid in route_cases:
        distance=o.length(a,b,step=sf,closed=avoid)
        closure=', '.join(c['name'] for c in data['vertical_connectors'] if c['id'] in avoid)
        words=f'Walk from {o.label(a)} to {o.label(b)}.'
        if sf:words+=' Do not use stairs or steps.'
        if closure:words+=f' These connectors are closed: {closure}.'
        words+=' Give the route and its total distance in metres, or say no route exists.'
        add(kind,words,number(distance,.01,1.) if distance is not None else {'reachable':False},
            {'start':a,'end':b,'step_free':sf,'closed':avoid})
    return items

def render_svg(data,floor_id):
    spaces=[s for s in data['spaces'] if s['floor_id']==floor_id]
    xmin=min(x for s in spaces for x,y in s['polygon']);ymin=min(y for s in spaces for x,y in s['polygon'])
    xmax=max(x for s in spaces for x,y in s['polygon']);ymax=max(y for s in spaces for x,y in s['polygon'])
    ppm=10.;w=(xmax-xmin+4)*ppm;h=(ymax-ymin+4)*ppm
    def pt(p):return ((p[0]-xmin+2)*ppm,(ymax-p[1]+2)*ppm)
    parts=[f'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 {w} {h}">',
        f'<defs><clipPath id="plot"><rect x="0" y="0" width="{w}" height="{h}"/></clipPath>',
        '<circle id="door-marker" r="2.2"/></defs>']
    for s in spaces:
        points=[pt(p) for p in s['polygon']]
        d=' '.join(('M' if i==0 else 'L')+f' {x:.6f} {y:.6f}' for i,(x,y) in enumerate(points))+' z'
        parts.append(f'<path d="{d}" style="fill: {COLORS[s["type"]]}; stroke: #333333; stroke-width: 0.6"/>')
        p=Polygon(s['polygon']).representative_point();x,y=pt((p.x,p.y));label=escape(s['ref'])
        parts.append(f'<text x="{x}" y="{y}" font-size="5">{label}</text>')
        parts.append(f'<!-- {label} -->\n<g transform="translate({x-1.908:.6f} {y+2.19:.6f}) scale(0.06 -0.06)"><use xlink:href="#glyph"/></g>')
    for o in data['openings']:
        if o['floor_id']!=floor_id:continue
        x,y=pt(o['position']);color='#d32f2f' if 'outside' in o['space_ids'] else '#8b4513'
        parts.append(f'<use xlink:href="#door-marker" x="{x}" y="{y}" style="fill: {color}; stroke: {color}"/>')
    parts.append('</svg>');return '\n'.join(parts)

def generate(run,cohort,seed,count):
    router=reference_class(run);rng=random.Random(seed);all_items=[];index=[];quarantine=[]
    for i in range(count):
        family=FAMILIES[i%8];item_seed=rng.getrandbits(48)
        data,meta=building(item_seed,family,i)
        path=run/'generated'/cohort/data['building']['id']
        try:items=questions(data,meta,router,i)
        except ValueError as e:
            quarantine.append({'seed':item_seed,'family':family,'reason':str(e)});continue
        dump(path/'building.json',data);dump(path/'generation.json',meta)
        for f in data['floors']:(path/f'floor_{f["level"]}.svg').write_text(render_svg(data,f['id']))
        for q in items:q['building_path']=str(path)
        all_items+=items;index.append({'building_id':data['building']['id'],'family':family,'seed':item_seed,'path':str(path)})
    dump(run/f'{cohort}_buildings.json',index);dump(run/f'{cohort}_quarantine.json',quarantine)
    dump(run/f'{cohort}_all_cases.json',all_items)
    return all_items

def balanced(items,per_kind,kinds):
    selected=[]
    for kind_index,kind in enumerate(kinds):
        pool=[q for q in items if q['kind']==kind]
        if len(pool)<per_kind:raise ValueError(f'Insufficient independent cases: {kind}: {len(pool)}')
        selected += [pool[(i+kind_index)%len(pool)] for i in range(per_kind)]
    return selected

def prepare_development(run):
    if (run/'development_cases.json').exists():return
    seed=read(run/'manifest.json')['development_seed']
    items=generate(run,'development',seed,32)
    # Six independent buildings per skill, all eight layout families remain in offline coverage.
    chosen=balanced(items,6,KINDS)
    dump(run/'development_cases.json',chosen)
    print(f'Development: {len(items)} independent-oracle cases, {len(chosen)} live cases')

def prepare_final(run):
    manifest=read(run/'manifest.json')
    if (run/'final_cases.json').exists():
        if source_hash(ROOT)!=manifest['candidate_sources']:raise ValueError('Candidate changed after freeze; final set is consumed')
        return
    manifest['candidate_sources']=source_hash(ROOT)
    manifest['final_seed']=secrets.randbits(48)
    manifest['candidate_frozen_at']=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()
    dump(run/'manifest.json',manifest)
    items=generate(run,'final',manifest['final_seed'],16)
    chosen=balanced(items,10,KINDS)+balanced(items,8,('route','route_step_free','route_disconnected'))
    dump(run/'final_cases.json',chosen)
    dump(run/'repeat_cases.json',balanced(items,2,KINDS))
    print(f'Candidate frozen. Final: {len(chosen)} cases; seeds generated after freeze.')
