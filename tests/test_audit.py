"""Audit validity: independent known answers, isolation, accounting and fixed quotas."""
import json
from pathlib import Path
import copy
import pytest
from evals.audit import dump,read,ledger_update,metered_client,sanitize,score,KINDS
from evals.audit_synthetic import Oracle,building,questions,shoelace,centroid,balanced
from starter_agent.building_map import BuildingMap


def test_oracle_polygon_math_has_known_answers():
    assert shoelace([[0,0],[6,0],[6,2],[2,2],[2,6],[0,6]])==20
    assert centroid([[0,0],[4,0],[4,2],[0,2]])==pytest.approx((2,1))
    assert centroid([[0,0],[6,0],[0,3]])==pytest.approx((2,1))


def test_reference_graph_matches_analytical_vertical_costs(tiny):
    o=Oracle(tiny.data,BuildingMap)
    assert o.length('T-F0-S0','T-F1-S0')==8.0
    assert o.length('T-F0-S0','T-F1-S0',step=True)==19.0
    assert o.length('T-F0-S0','T-F1-S0',step=True,closed=['T-V-lift']) is None
    assert 'T-F0-S1' in o.distances('T-F0-S0',width=.9)
    assert 'T-F0-S1' not in o.distances('T-F0-S0',width=.901)
    assert o.stacked('T-F0-S1','above')=='T-F1-S1'
    assert len(o.walls('T-F0-S1'))==0  # corridor is excluded


def test_reference_keeps_outside_sections_disconnected():
    data,meta=building(9123,'disconnected',0);o=Oracle(data,BuildingMap)
    low=next(iter(meta['levels'].values()))
    assert o.length(low['rooms'][0],low['isolated']) is None
    assert low['isolated'] in o.exits()


def test_exact_new_door_geometry_has_known_gain():
    # Two adjacent rectangles with existing doors at their opposite ends.
    # A midpoint door halves the room-to-room walk: oracle uses the explicit position.
    d={'building':{'id':'t'},'floors':[{'id':'f','level':0,'elevation_m':0}],
       'spaces':[{'id':'a','floor_id':'f','type':'room','room_type':'office','name':'A','ref':'A','polygon':[[0,0],[4,0],[4,4],[0,4]]},
                 {'id':'b','floor_id':'f','type':'room','room_type':'office','name':'B','ref':'B','polygon':[[4,0],[8,0],[8,4],[4,4]]}],
       'assets':[],'vertical_connectors':[],
       'openings':[{'id':'in','floor_id':'f','space_ids':['outside','a'],'position':[0,2],'width_m':1.,'step_free':True,'kind':'entrance'}]}
    o=Oracle(d,BuildingMap)
    assert o.length('a','b') is None
    e={'id':'new','floor_id':'f','space_ids':['a','b'],'position':[4,2],'width_m':.9,'step_free':True,'kind':'door'}
    assert o.length('a','b',extra=e)==pytest.approx(4.,abs=.001)
    assert o.exits(extra=e)['b']==pytest.approx(6.,abs=.001)


def test_generated_answer_keys_and_selection_do_not_import_production_engine():
    import evals.audit_synthetic as m
    source=Path(m.__file__).read_text()
    assert 'from navcore' not in source and 'from navagent' not in source
    all_items=[]
    for i,family in enumerate(m.FAMILIES):
        data,meta=building(301+i,family,i)
        all_items+=questions(data,meta,BuildingMap,i)
    selected=balanced(all_items,6,KINDS)
    assert len(selected)==54
    assert {q['source'] for q in selected}==set(m.FAMILIES)
    assert all(sum(q['kind']==k for q in selected)==6 for k in KINDS)


def test_sanitized_runtime_input_contains_no_answer_files(tmp_path):
    b=tmp_path/'original';b.mkdir()
    data,meta=building(123,'industrial',0)
    data['answer']='forbidden';dump(b/'building.json',data)
    dump(b/'questions.jsonl',{'answer':'forbidden','inputs':'forbidden'})
    p=sanitize(tmp_path,b)
    assert {f.name for f in p.iterdir()}=={'building.json'}
    assert 'answer' not in read(p/'building.json')


def test_budget_rejects_before_sending_request(tmp_path,monkeypatch):
    import httpx2
    monkeypatch.setenv('ANTHROPIC_API_KEY','unit-test-key')
    calls=[]
    monkeypatch.setattr(httpx2.HTTPTransport,'handle_request',lambda self,request:calls.append(request))
    dump(tmp_path/'ledger.json',{'cap_usd':.01,'requests':[]})
    client=metered_client(tmp_path,'case','test')
    with pytest.raises(Exception,match='Connection error|AUDIT_BUDGET_STOP'):
        client.beta.messages.create(model='claude-opus-5-5',max_tokens=16000,messages=[{'role':'user','content':'hello'}])
    assert calls==[] and read(tmp_path/'ledger.json')['requests']==[]


def test_meter_settles_real_usage_and_keeps_uncertain_charges(tmp_path,monkeypatch):
    import httpx2
    monkeypatch.setenv('ANTHROPIC_API_KEY','unit-test-key')
    dump(tmp_path/'ledger.json',{'cap_usd':100.,'requests':[]})
    def fake(self,request):
        return httpx2.Response(200,json={'id':'msg_x','type':'message','role':'assistant','model':'claude-opus-5-5',
          'content':[{'type':'text','text':'OK'}],'stop_reason':'end_turn','stop_sequence':None,
          'usage':{'input_tokens':100,'output_tokens':10,'cache_read_input_tokens':20,'cache_creation_input_tokens':30}},request=request)
    monkeypatch.setattr(httpx2.HTTPTransport,'handle_request',fake)
    client=metered_client(tmp_path,'case','test')
    client.beta.messages.create(model='claude-opus-5-5',max_tokens=10,messages=[{'role':'user','content':'hi'}])
    row=read(tmp_path/'ledger.json')['requests'][0]
    assert row['status']=='settled'
    assert row['charged_or_reserved_usd']==pytest.approx(.000754)
    def timeout(self,request):raise httpx2.ReadTimeout('test')
    monkeypatch.setattr(httpx2.HTTPTransport,'handle_request',timeout)
    with pytest.raises(Exception):
        client.beta.messages.create(model='claude-opus-5-5',max_tokens=10,messages=[{'role':'user','content':'hi'}])
    rows=read(tmp_path/'ledger.json')['requests']
    assert len(rows)==2 and rows[1]['status']=='unknown_charge_reserved'
    assert rows[1]['charged_or_reserved_usd']==rows[1]['reserved_usd']


def test_scorer_rejects_wrong_number_even_if_prose_says_correct():
    item={'answer':{'type':'number','value':12.,'relative_tolerance':.01,'absolute_tolerance':0}}
    assert score(item,'Answer: 12')
    assert not score(item,'The right number is 12.\nAnswer: 24')
    assert not score(item,'Answer: 12 or 24')


def test_completed_phase_cannot_be_reused_after_code_or_case_changes(tmp_path):
    from evals.audit import phase_receipt
    source=tmp_path/'source';(source/'navcore').mkdir(parents=True)
    module=source/'navcore/engine.py';module.write_text('version = 1\n')
    b=tmp_path/'building';dump(b/'building.json',{'building':{'id':'one'}})
    cases=[{'id':'q','question':'how many?','answer':{'type':'number','value':1},'building_path':str(b)}]
    run=tmp_path/'run';phase_receipt(run,cases,'final',source)
    phase_receipt(run,cases,'final',source)
    module.write_text('version = 2\n')
    with pytest.raises(ValueError,match='cached results cannot be reused'):
        phase_receipt(run,cases,'final',source)
    module.write_text('version = 1\n');cases[0]['question']='different question'
    with pytest.raises(ValueError,match='cached results cannot be reused'):
        phase_receipt(run,cases,'final',source)
