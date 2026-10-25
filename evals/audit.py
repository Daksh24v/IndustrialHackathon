"""Reproducible, budgeted judge audit. See AUDIT.md for the protocol.

python -m evals.audit prepare --run-id judge-20261025
python -m evals.audit baseline --run-id judge-20261025
python -m evals.audit validate --run-id judge-20261025
python -m evals.audit report --run-id judge-20261025

Answer keys stay in the controller. A subprocess receives only a sanitized building,
a question, and runtime code. API retries are disabled in this audit so an unknown
billing outcome cannot silently trigger another paid attempt.
"""
from __future__ import annotations
import argparse
import collections
import contextlib
import csv
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import random
import shutil
import statistics
import subprocess
import sys
import tarfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'agent_output' / 'audit'
REFERENCE = ROOT.parent / 'industrial-agents-hackathon-2026-reference'
KINDS = ('largest_room', 'floor_area_total', 'errand', 'wide_delivery_count',
         'step_free_reachable_count', 'room_stacked', 'shared_walls_count',
         'straight_line_3d', 'what_if_door')
PRICES = {'input_tokens': 4., 'output_tokens': 20., 'cache_read_input_tokens': .2,
          'cache_creation_input_tokens': 5.}
PRICING_URL = 'https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5'

def dump(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False, default=str) + '\n')
    tmp.replace(path)

def read(path):
    return json.loads(Path(path).read_text())

def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def source_hash(root):
    return {str(p.relative_to(root)): digest(p) for folder in ('navcore','navagent','starter_agent','benchmark')
            for p in sorted((root/folder).glob('*.py'))}

def ledger_update(run, fn):
    with (run/'ledger.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        ledger = read(run/'ledger.json')
        result = fn(ledger)
        dump(run/'ledger.json', ledger)
        return result

def prepare(run, cap):
    if (run/'manifest.json').exists():
        print(f'Already prepared: {run}'); return
    if not 0 < cap <= 100:
        raise ValueError('Audit cap must be greater than zero and at most $100')
    run.mkdir(parents=True, exist_ok=True)
    baseline = run/'baseline_source'; baseline.mkdir()
    paths = ['navcore','navagent','starter_agent','benchmark','pyproject.toml','uv.lock']
    archive = subprocess.check_output(['git','archive','HEAD',*paths], cwd=ROOT)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        tar.extractall(baseline, filter='data')
    shutil.copy2(REFERENCE/'starter_agent/building_map.py', run/'reference_router.py')
    tracked_data = {str(p.relative_to(ROOT)):digest(p) for p in sorted((ROOT/'data').rglob('*'))
                    if p.is_file() and p.suffix in ('.json','.jsonl','.csv') and 'imported' not in p.parts}
    from navagent.agent import MODEL, EFFORT, COMMON_RULES, BENCHMARK_RULES
    manifest = {'created_utc':dt.datetime.now(dt.timezone.utc).isoformat(),
        'baseline_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'organizer_commit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=REFERENCE,text=True).strip(),
        'model':MODEL,'effort':EFFORT,'prompt_sha256':hashlib.sha256((COMMON_RULES+BENCHMARK_RULES).encode()).hexdigest(),
        'baseline_sources':source_hash(baseline),'lock_sha256':digest(ROOT/'uv.lock'),
        'official_scorer_sha256':digest(REFERENCE/'benchmark/score.py'),
        'reference_router_sha256':digest(run/'reference_router.py'),'dataset_hashes':tracked_data,
        'split_hashes':{n:digest(ROOT/'holdout'/f'{n}.txt') for n in ('build','holdout')},
        'prices_per_million':PRICES,'pricing_source':PRICING_URL,'pricing_verified_date':'2026-10-25',
        'budget_usd':cap,'development_seed':202610250817,'final_seed':None,
        'protocol':{'final_benchmark_per_kind':10,'final_routes':24,'development_live_max':54,
                    'candidate_repeats':18,'final_buildings':16,'development_buildings':32,
                    'threshold_overall':.95,'threshold_per_kind':.9,
                    'selection':'fixed quotas before outcomes, fresh final seed after candidate freeze',
                    'holdout_status':'historical, previously evaluated; not newly blind',
                    'retry_policy':'one application attempt; zero SDK retries; unknown charge retains reservation'}}
    assert digest(ROOT/'benchmark/score.py') == manifest['official_scorer_sha256']
    dump(run/'manifest.json',manifest)
    dump(run/'ledger.json',{'cap_usd':cap,'requests':[]})
    dump(run/'environment.json',{'python':sys.version,
        'packages':subprocess.check_output([sys.executable,'-m','pip','list','--format=json'],text=True,stderr=subprocess.DEVNULL)
        if subprocess.run([sys.executable,'-m','pip','--version'],capture_output=True).returncode==0 else 'uv.lock pinned'})
    ids = set((ROOT/'holdout/holdout.txt').read_text().split())
    historical=[]
    for split in ('train','dev'):
        for path in sorted((ROOT/'data'/split).glob('*/questions.jsonl')):
            if path.parent.name not in ids: continue
            info = read(path.parent/'building.json')['building']
            for line in path.read_text().splitlines():
                q=json.loads(line)
                historical.append({**q,'building_path':str(path.parent),'source':info['source'],'cohort':'historical'})
    assert len(historical)==128
    dump(run/'historical.json',historical)
    print(f'Prepared {run}; baseline {manifest["baseline_commit"]}; {len(historical)} historical cases',flush=True)

def metered_client(run, case_id, phase):
    import httpx2 as httpx
    import anthropic
    # No secrets are persisted in request records. Reserve a conservative upper bound
    # before each HTTP call: at most one token per UTF-8 byte, plus framing overhead,
    # at prices above the current normal/fallback models, including a second billed pass.
    class Meter(httpx.BaseTransport):
        def __init__(self): self.inner=httpx.HTTPTransport(retries=0)
        def handle_request(self, request):
            payload=json.loads(request.content) if request.content else {}
            if request.method != 'POST' or not request.url.path.endswith('/messages'):
                return self.inner.handle_request(request)
            bound=2*((len(request.content)+8192)*20+payload.get('max_tokens',16000)*100)/1e6
            def reserve(l):
                used=sum(x['charged_or_reserved_usd'] for x in l['requests'])
                if used+bound>l['cap_usd']:
                    raise RuntimeError(f'AUDIT_BUDGET_STOP: ${used:.2f} used/reserved + ${bound:.2f} reservation')
                index=len(l['requests'])
                l['requests'].append({'id':index,'case_id':case_id,'phase':phase,'time':time.time(),
                    'requested_model':payload.get('model'),'reserved_usd':bound,
                    'charged_or_reserved_usd':bound,'status':'pending'})
                return index
            index=ledger_update(run,reserve)
            try:
                response=self.inner.handle_request(request)
                response.read()
                body=response.json()
                usage=body.get('usage')
                def settle(l):
                    item=l['requests'][index]; item['http_status']=response.status_code
                    if usage is not None:
                        model=body.get('model','unknown')
                        prices=PRICES if model.startswith('claude-opus-5-5') else {
                            'input_tokens':20.,'output_tokens':100.,'cache_read_input_tokens':20.,'cache_creation_input_tokens':25.}
                        cost=sum((usage.get(k) or 0)*v for k,v in prices.items())/1e6
                        item.update(usage=usage,returned_model=model,charged_or_reserved_usd=cost,
                                    status='settled' if model.startswith('claude-opus-5-5') else 'conservative_fallback_price')
                    elif 400<=response.status_code<500 and response.status_code not in (408,):
                        item.update(charged_or_reserved_usd=0.,status='rejected')
                    else: item['status']='unknown_charge_reserved'
                ledger_update(run,settle)
                return response
            except BaseException:
                def unknown(l): l['requests'][index]['status']='unknown_charge_reserved'
                ledger_update(run,unknown)
                raise
        def close(self): self.inner.close()
    return anthropic.Anthropic(max_retries=0,timeout=180,http_client=httpx.Client(transport=Meter(),timeout=180))

def worker(run, request_path, output_path, source):
    # Executed with `python -I`: only chosen runtime code is inserted in sys.path.
    sys.path.insert(0,str(source))
    from navagent.agent import BuildingAgent, BENCHMARK
    from navagent.tools import Session
    from navcore.engine import Building
    req=read(request_path)
    agent=BuildingAgent(Session(Building.load(Path(req['building_path']))),
          client=metered_client(run,req['id'],req['phase']),mode=BENCHMARK,
          log_path=run/'logs'/f'{req["phase"]}-{req["id"]}.json')
    start=time.monotonic()
    try:
        reply=agent.answer_benchmark(req['question']); error=None
    except Exception as exc:
        reply=''; error=f'{type(exc).__name__}: {exc}'
    dump(output_path,{'reply':reply,'error':error,'seconds':time.monotonic()-start,
                     'usage':agent.usage,'submitted':agent.session.submitted,
                     'route':agent.session.active_route})

def sanitize(run, building):
    source=Path(building); data=read(source/'building.json')
    # Only schema fields the engine needs; no question files, inputs, answers or previous outputs.
    public={k:data[k] for k in ('building','floors','spaces','openings','vertical_connectors','assets') if k in data}
    key=hashlib.sha256(json.dumps(public,sort_keys=True).encode()).hexdigest()[:20]
    dest=run/'public_buildings'/key
    if not dest.exists(): dump(dest/'building.json',public)
    return dest

def score(item, reply):
    from benchmark.score import score_reply, committed_answer, numbers_in
    if item['answer'].get('type') in ('number','space'):
        return score_reply(item['answer'],reply)
    text=committed_answer(reply) or ''
    if item['answer'].get('reachable') is False:
        import re
        return bool(re.search(r'\b(no|not|unreachable|impossible)\b',text,re.I)) and not re.search(r'\d\s*(m|metres|meters)\b',text,re.I)
    return False

def phase_receipt(run, items, phase, source):
    """Do not reuse paid results after changing code, inputs, or expected answers."""
    payload=[{'id':q['id'],'question':q['question'],'answer':q['answer'],
              'building_sha256':digest(Path(q['building_path'])/'building.json')} for q in items]
    receipt={'source_hashes':source_hash(source),
             'cases_sha256':hashlib.sha256(json.dumps(payload,sort_keys=True).encode()).hexdigest()}
    path=run/'phase_receipts'/f'{phase}.json'
    if path.exists() and read(path)!=receipt:
        raise ValueError(f'{phase}: code or cases changed; cached results cannot be reused. Use a fresh phase/run.')
    dump(path,receipt)
    return receipt

def run_cases(run, items, phase, source=None, workers=3):
    from concurrent.futures import ThreadPoolExecutor, as_completed
    source=source or ROOT
    phase_receipt(run,items,phase,source)
    result_file=run/f'{phase}.jsonl'
    old=[json.loads(x) for x in result_file.read_text().splitlines()] if result_file.exists() else []
    done={x['id'] for x in old}
    pending=[x for x in items if x['id'] not in done]
    def one(item):
        cid=item['id']; directory=run/'requests'/phase/cid
        directory.mkdir(parents=True,exist_ok=True)
        public=sanitize(run,item['building_path'])
        dump(directory/'input.json',{'id':cid,'phase':phase,'building_path':str(public),'question':item['question']})
        cmd=[sys.executable,'-I',str(Path(__file__).resolve()),'_worker','--run-path',str(run),
             '--request',str(directory/'input.json'),'--output',str(directory/'output.json'),'--source',str(source)]
        started=time.monotonic()
        if (directory/'output.json').exists():
            value=read(directory/'output.json')
            return {'id':cid,'kind':item['kind'],'building_id':item['building_id'],
                    'source':item.get('source','synthetic'),'correct':score(item,value.get('reply','')),**value}
        try:
            proc=subprocess.run(cmd,cwd=public,capture_output=True,text=True,timeout=300)
            value=read(directory/'output.json') if (directory/'output.json').exists() else {
                'reply':'','error':proc.stderr[-1500:],'seconds':time.monotonic()-started}
        except subprocess.TimeoutExpired:
            value={'reply':'','error':'AUDIT_QUESTION_TIMEOUT_300S','seconds':time.monotonic()-started}
        return {'id':cid,'kind':item['kind'],'building_id':item['building_id'],
                'source':item.get('source','synthetic'),'correct':score(item,value.get('reply','')),
                **value}
    with ThreadPoolExecutor(max_workers=workers) as pool, result_file.open('a') as log:
        futures={pool.submit(one,item):item for item in pending}
        for fut in as_completed(futures):
            row=fut.result(); log.write(json.dumps(row,ensure_ascii=False,default=str)+'\n');log.flush()
            old.append(row)
            print(f'{phase}: {len(old)}/{len(items)}; correct {sum(x["correct"] for x in old)}; last {row["id"]}: {"OK" if row["correct"] else "FAIL"}',flush=True)
    return old

def bootstrap(rows, iterations=2000):
    groups=collections.defaultdict(list)
    for r in rows: groups[r['building_id']].append(r['correct'])
    if not groups:return None
    arrays=list(groups.values()); rng=random.Random(56129); values=[]
    for _ in range(iterations):
        sample=[v for group in rng.choices(arrays,k=len(arrays)) for v in group]
        values.append(sum(sample)/len(sample))
    values.sort();return [values[int(.025*iterations)],values[int(.975*iterations)]]

def report(run):
    datasets={}
    for path in sorted(run.glob('*.jsonl')):
        rows=[json.loads(x) for x in path.read_text().splitlines()]
        if not rows or 'correct' not in rows[0]:continue
        by_kind={k:{'correct':sum(r['correct'] for r in rows if r['kind']==k),
                    'total':sum(r['kind']==k for r in rows)} for k in sorted({r['kind'] for r in rows})}
        by_source={k:{'correct':sum(r['correct'] for r in rows if r['source']==k),
                      'total':sum(r['source']==k for r in rows)} for k in sorted({r['source'] for r in rows})}
        times=sorted(r.get('seconds',0) for r in rows)
        datasets[path.stem]={'correct':sum(r['correct'] for r in rows),'total':len(rows),'by_kind':by_kind,
            'by_source':by_source,'cluster_bootstrap_95':bootstrap(rows),'median_seconds':statistics.median(times),
            'p95_seconds':times[min(len(times)-1,int(.95*len(times)))],
            'failures':[{'id':r['id'],'kind':r['kind'],'error':r.get('error')} for r in rows if not r['correct']]}
    ledger=read(run/'ledger.json')
    costs=collections.Counter()
    for x in ledger['requests']:costs[x['phase']]+=x['charged_or_reserved_usd']
    summary={'datasets':datasets,'charged_or_reserved_usd':sum(costs.values()),'cost_by_phase':dict(costs),
             'requests':len(ledger['requests']),'unknown_charge_requests':sum(x['status'] in ('pending','unknown_charge_reserved') for x in ledger['requests'])}
    dump(run/'summary.json',summary)
    lines=['# FINNI judge audit', '',f'Baseline commit: `{read(run/"manifest.json")["baseline_commit"]}`.',
           f'API charges plus unresolved reservations: **${summary["charged_or_reserved_usd"]:.4f} / ${ledger["cap_usd"]:.0f}**.',
           '', '| Cohort | Correct | Accuracy | Building-cluster 95% interval | Median / p95 seconds |',
           '|---|---:|---:|---|---|']
    for name,d in datasets.items():
        ci=d['cluster_bootstrap_95'];lines.append(f'| {name} | {d["correct"]}/{d["total"]} | {d["correct"]/d["total"]:.1%} | {ci[0]:.1%}–{ci[1]:.1%} | {d["median_seconds"]:.1f} / {d["p95_seconds"]:.1f} |')
    lines+=['','Historical holdout was previously evaluated. Synthetic results describe the registered generator distribution, not a guarantee on unseen real buildings. Official test accuracy is unavailable without hidden labels.','']
    for name,d in datasets.items():
        lines += [f'## {name}', '', '| Skill | Correct |', '|---|---:|']
        lines += [f'| {k} | {v["correct"]}/{v["total"]} |' for k,v in d['by_kind'].items()]
        lines += ['']
    (run/'REPORT.md').write_text('\n'.join(lines))
    from evals.audit_report import enrich
    summary = enrich(run, summary)
    print(json.dumps({"datasets":{k:{"correct":v["correct"],"total":v["total"]} for k,v in summary["datasets"].items()},
                      "actual_settled_usd":summary["actual_settled_usd"],"acceptance":summary["acceptance"]},indent=2))

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('phase',choices=['prepare','baseline','validate','report','_worker'])
    parser.add_argument('--run-id',default='judge-20261025')
    parser.add_argument('--budget-usd',type=float,default=100.)
    parser.add_argument('--run-path',type=Path)
    parser.add_argument('--request',type=Path);parser.add_argument('--output',type=Path);parser.add_argument('--source',type=Path)
    args=parser.parse_args()
    if not args.run_id.replace('-','').replace('_','').isalnum():parser.error('invalid run id')
    run=(args.run_path or OUTPUT/args.run_id).resolve()
    if args.phase=='prepare':prepare(run,args.budget_usd)
    elif args.phase=='_worker':worker(run,args.request,args.output,args.source)
    elif args.phase=='baseline':
        from evals.audit_synthetic import prepare_development
        from evals.audit_checks import check_development, check_transforms, check_imports
        from evals.audit_dialogues import run_dialogues
        prepare_development(run)
        check_development(run)
        check_transforms(run)
        check_imports(run)
        run_cases(run,read(run/'historical.json'),'historical_baseline',run/'baseline_source')
        run_cases(run,read(run/'development_cases.json'),'development_live')
        run_dialogues(run)
    elif args.phase=='validate':
        from evals.audit_synthetic import prepare_final
        prepare_final(run)
        items=read(run/'final_cases.json')
        run_cases(run,items,'final_baseline',run/'baseline_source')
        run_cases(run,items,'final_candidate')
        repeats=[{**x,'id':x['id']+'-repeat'} for x in read(run/'repeat_cases.json')]
        run_cases(run,repeats,'candidate_repeat')
        from evals.audit_checks import check_routes
        from evals.audit_sunday import run_sunday
        check_routes(run, 'final_baseline')
        check_routes(run, 'final_candidate')
        run_sunday(run)
    else:report(run)

if __name__=='__main__':main()
