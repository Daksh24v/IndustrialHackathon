"""Real benchmark entrypoint on a fresh, answer-free Sunday-style directory."""
import json
import secrets
from pathlib import Path
from evals.audit import read,dump,score,metered_client
from evals.audit_synthetic import building,questions,reference_class,render_svg


def run_sunday(run):
    from navagent import answer as answer_module
    from navagent import benchmark
    from evals.check_submission import Report,read_rows
    public=run/'sunday_input'
    if not (run/'sunday_keys.json').exists():
        data,meta=building(secrets.randbits(48),'industrial',64)
        items=questions(data,meta,reference_class(run),64)
        public.mkdir(exist_ok=True)
        dump(public/'building.json',data)
        for f in data['floors']:(public/f'floor_{f["level"]}.svg').write_text(render_svg(data,f['id']))
        with (public/'questions.jsonl').open('w') as out:
            for q in items:out.write(json.dumps({k:q[k] for k in ('id','building_id','kind','question')})+'\n')
        dump(run/'sunday_keys.json',items)
    items=read(run/'sunday_keys.json')
    answer_module._client=metered_client(run,'sunday-entrypoint','sunday')
    answer_module.LOG_DIRECTORY=run/'logs'/'sunday'
    out=run/'sunday_answers.csv'
    if not out.exists():benchmark.run(public,out)
    fmt=Report();rows=read_rows(out.read_bytes(),fmt)
    assert set(rows)=={q['id'] for q in items}
    scored=[{'id':q['id'],'kind':q['kind'],'building_id':q['building_id'],'source':'sunday',
             'correct':score(q,rows[q['id']]),'reply':rows[q['id']],'error':None} for q in items]
    with (run/'sunday.jsonl').open('w') as f:
        for row in scored:f.write(json.dumps(row)+'\n')
    dump(run/'sunday_format.json',{'valid':not fmt.format_errors,'errors':fmt.format_errors,
          'rows':len(rows),'bytes':out.stat().st_size,'input_fields':['id','building_id','kind','question'],
          'command_equivalent':'python -m navagent.benchmark <fresh_directory> --out <csv>',
          'client_override':'metered Anthropic client only; model, prompts, tools unchanged'})
    print('Sunday:',sum(r['correct'] for r in scored),'/',len(scored),'format errors',fmt.format_errors)
