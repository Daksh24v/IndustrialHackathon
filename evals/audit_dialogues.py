"""Eight registered judge conversations, checked through state and route evidence."""
from __future__ import annotations
import copy
import json
from pathlib import Path
import time
from concurrent.futures import ThreadPoolExecutor,as_completed
from evals.audit import read,dump,metered_client
from evals.audit_synthetic import Oracle,reference_class

SCENARIOS=('ambiguous_destination','unknown_position','remember_wheelchair','lift_closure',
           'changed_destination','moved_equipment','added_door','builder_conversation')


def run_one(run,index,name):
    from navagent.agent import BuildingAgent,CHAT,BUILDER
    from navagent.tools import Session
    from navagent.builder import Draft
    from navcore.engine import Building
    # Each script uses its own generated building and fresh state. Keys never enter the agent prompt.
    record=read(run/'development_buildings.json')[index+8]
    path=Path(record['path']);data=read(path/'building.json');meta=read(path/'generation.json')
    levels=list(meta['levels'].values());low=levels[0];upper=levels[-1];turns=[];assertions=[]
    mode=CHAT
    if name=='ambiguous_destination':
        for s in data['spaces']:
            if s['id'] in low['rooms'][:2]:s['name']='Office'
    session=Session(Building(data));draft=None
    if name=='builder_conversation':
        draft=Draft.from_svgs([(p.name,p.read_text()) for p in sorted(path.glob('floor_*.svg'))],
                             'audit-builder-'+record['building_id'])
        session=Session(draft.loaded(),draft=draft);mode=BUILDER
    agent=BuildingAgent(session,metered_client(run,name,'dialogues'),mode=mode,
                       log_path=run/'logs'/f'dialogue-{name}.json')
    label=lambda sid:session.building.label(sid)
    def ask(text):
        reply=agent.ask(text)
        turns.append({'user':text,'reply':reply,'pending':copy.deepcopy(session.pending_question),
             'position':session.here,'route':copy.deepcopy(session.active_route),
             'route_elements':[e for leg in session.last_route or [] for e in leg.element_path],
             'closed':sorted(session.closed|set(session.reported)),
             'profile':session.profile.name if session.profile else None})
        return reply
    def check(condition,description):assertions.append({'passed':bool(condition),'check':description})
    start=time.monotonic();error=None
    try:
        if name=='ambiguous_destination':
            session.set_position(low['corridor'])
            ask('Take me to the Office on this floor.')
            check(session.pending_question is not None and session.active_route is None,'asks which same-named office before routing')
            ask('I mean room '+session.building.spaces[low['rooms'][1]]['ref']+'.')
            check(session.active_route and session.active_route['destination']==low['rooms'][1],'uses disambiguating room number')
        elif name=='unknown_position':
            ask(f'I am lost on {session.building.floor_name(low["floor"])}. Please get me to {label(low["rooms"][2])}.')
            check(session.pending_question is not None,'asks for observable position evidence')
            if session.pending_question:
                ask(session.pending_question['options'][0]['label'])
            check(session.active_route is not None and session.pending_question is None,'one landmark answer enables route')
        elif name=='remember_wheelchair':
            ask(f'I use a wheelchair. I am in {label(low["rooms"][0])}. Take me to {label(upper["rooms"][3])}.')
            check(session.profile and session.profile.name=='wheelchair','stores wheelchair preference')
            ask(f'Now take me to {label(upper["rooms"][2])} instead.')
            elements=[e for leg in session.last_route or [] for e in leg.element_path]
            stairs={c['id'] for c in data['vertical_connectors'] if c['kind']=='stairs'}
            check(session.active_route and not stairs.intersection(elements),'subsequent route does not use stairs')
            check(session.pending_question is None,'does not re-ask known mobility or position')
        elif name=='lift_closure':
            session.on_report=lambda report,fixed:{'report':report,'maintenance':{'channel':'audit_stub','sent':True}}
            ask(f'I am in {label(low["rooms"][0])} and use a wheelchair. Take me to {label(upper["rooms"][3])}.')
            ask('The West lift has just broken. Report it and find another way to the same destination.')
            check(meta['lift_connector'] in session.reported,'closure recorded for the simulated shared service')
            oracle=Oracle(data,reference_class(run))
            reachable=oracle.length(low['rooms'][0],upper['rooms'][3],step=True,closed=[meta['lift_connector']]) is not None
            check((session.active_route is not None)==reachable,'replans or states no route according to remaining lift connectivity')
            check(all(meta['lift_connector'] not in t['route_elements'] for t in turns[-1:]),'closed lift absent from replacement route')
        elif name=='changed_destination':
            session.set_position(low['rooms'][0],source='phone')
            ask(f'Take me to {label(upper["rooms"][3])}.')
            ask(f'I am now in {label(low["corridor"])}. Change the destination to {label(low["rooms"][2])}.')
            check(session.active_route and session.active_route['stops'][0]==low['corridor'],'starts at corrected position')
            check(session.active_route and session.active_route['destination']==low['rooms'][2],'destination changed')
        elif name=='moved_equipment':
            asset=next(a for a in data['assets'] if a['type']=='drill' and a['space_id']==low['rooms'][0])
            session.set_position(low['corridor'])
            ask(f'The {asset["name"]} has been moved to {label(upper["rooms"][3])}. Record that.')
            ask(f'Take me to {asset["name"]}.')
            check(session.active_route and session.active_route['destination']==upper['rooms'][3],'route follows relocated equipment')
            check(asset['id'] in session.moved,'asset update retained in session')
        elif name=='added_door':
            edit=meta['new_door'];session.set_position(edit['first'])
            ask(f'Add a step-free door, 1.2 metres wide, in the middle of the shared wall between '
                f'{label(edit["first"])} and {label(edit["second"])}.')
            check(any(set(o['space_ids'])=={edit['first'],edit['second']} and o['width_m']==1.2 for o in session.new_openings),'door edit applied with requested width')
            ask(f'Now take me to {label(edit["second"])}.')
            check(any(e.startswith(low['floor']+'-O-new') for leg in session.last_route or [] for e in leg.element_path),'new route uses new doorway')
        else:
            ask('I am setting up this building from its floor plans. Tell me what information you still need.')
            check(session.pending_question is not None,'builder asks about missing metadata')
            room=next(s for s in draft.building['spaces'] if s['type']=='room' and s.get('ref'))
            level=next(f['name'] for f in draft.building['floors'] if f['id']==room['floor_id'])
            ask(f'Room {room["ref"]} on {level} is an office. All door widths are 1.2 m. Every floor is 4.2 m high. Apply this; do not save yet.')
            check(all(abs(o['width_m']-1.2)<1e-6 for o in draft.building['openings']),'builder applies door widths')
            check(next(s for s in draft.building['spaces'] if s['id']==room['id'])['room_type']=='office','builder applies room type')
            check(all(abs(f.get('height_m',0)-4.2)<1e-6 for f in draft.building['floors']),'builder applies supplied heights')
            check(draft.saved_to is None,'draft remains unsaved until requested')
    except Exception as exc:error=f'{type(exc).__name__}: {exc}'
    result={'id':name,'kind':name,'building_id':record['building_id'],'source':'conversation',
            'correct':error is None and bool(assertions) and all(x['passed'] for x in assertions),
            'checks':assertions,'error':error,'seconds':time.monotonic()-start,'turns':turns,'usage':agent.usage}
    dump(run/'dialogue_results'/f'{name}.json',result)
    return result


def run_dialogues(run):
    done={p.stem:read(p) for p in (run/'dialogue_results').glob('*.json')}
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures=[pool.submit(run_one,run,i,name) for i,name in enumerate(SCENARIOS) if name not in done]
        for f in as_completed(futures):
            result=f.result();done[result['id']]=result
            print(result['id'],result['correct'],result['checks'],flush=True)
    with (run/'dialogues.jsonl').open('w') as f:
        for name in SCENARIOS:f.write(json.dumps(done[name],ensure_ascii=False)+'\n')
