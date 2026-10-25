"""Interpret audit evidence without converting consistency into accuracy claims."""
from __future__ import annotations
import collections
import json
import math
from pathlib import Path
import statistics
from evals.audit import KINDS,dump,read,source_hash,ROOT,digest


def wilson(success,total):
    if not total:return None
    z=1.959963984540054;p=success/total;denom=1+z*z/total
    middle=(p+z*z/(2*total))/denom
    radius=z*math.sqrt(p*(1-p)/total+z*z/(4*total*total))/denom
    return [max(0,middle-radius),min(1,middle+radius)]


def load_rows(run,name):
    path=run/f'{name}.jsonl'
    return [json.loads(x) for x in path.read_text().splitlines()] if path.exists() else []


def enrich(run,summary):
    candidate=load_rows(run,'final_candidate');baseline=load_rows(run,'final_baseline')
    scored=[q for q in candidate if q['kind'] in KINDS]
    base_scored=[q for q in baseline if q['kind'] in KINDS]
    routes=read(run/'final_candidate_route_validity.json') if (run/'final_candidate_route_validity.json').exists() else []
    exact={q['id']:q for q in candidate};base={q['id']:q for q in baseline}
    repeats=load_rows(run,'candidate_repeat')
    repeat_checks=[]
    for q in repeats:
        first=exact.get(q['id'].removesuffix('-repeat'))
        repeat_checks.append({'id':q['id'],'correct':q['correct'],
             'submitted_equal':bool(first and q.get('submitted')==first.get('submitted'))})
    from benchmark.score import committed_answer
    by_kind={k:{'correct':sum(q['correct'] for q in scored if q['kind']==k),
                'total':sum(q['kind']==k for q in scored)} for k in KINDS}
    per_building=collections.defaultdict(list)
    for q in scored:per_building[q['building_id']].append(q['correct'])
    building_all=sum(all(v) for v in per_building.values());buildings=len(per_building)
    regressions=[q['id'] for q in candidate if not q['correct'] and base.get(q['id'],{}).get('correct')]
    improvements=[q['id'] for q in candidate if q['correct'] and q['id'] in base and not base[q['id']]['correct']]
    complete=(len(candidate)==114 and len(baseline)==114 and len(repeats)==18)
    missing_format=[q['id'] for q in candidate if not committed_answer(q.get('reply',''))]
    gates={'complete_final_and_repeats':complete,
        'at_least_95_percent_benchmark':len(scored)==90 and sum(q['correct'] for q in scored)/90>=.95,
        'at_least_9_of_10_each_skill':all(v['total']==10 and v['correct']>=9 for v in by_kind.values()),
        'all_24_routes_valid':len(routes)==24 and all(q['valid'] for q in routes),
        'answer_format':len(candidate)==114 and not missing_format,
        'no_observed_regression':len(candidate)==len(baseline)==114 and not regressions,
        'candidate_fingerprint_unchanged':source_hash(ROOT)==read(run/'manifest.json').get('candidate_sources')}
    summary.update(acceptance=gates,acceptance_passed=all(gates.values()),
        final_benchmark={'correct':sum(q['correct'] for q in scored),'total':len(scored),'by_kind':by_kind,
            'buildings_all_correct':building_all,'buildings':buildings,
            'building_all_correct_wilson_95':wilson(building_all,buildings)},
        paired={'regressions':regressions,'improvements':improvements,
                'production_code_identical':read(run/'manifest.json')['baseline_sources']==read(run/'manifest.json').get('candidate_sources')},
        repeat_checks=repeat_checks)
    ledger=read(run/'ledger.json')
    tokens=collections.Counter();models=collections.Counter()
    for req in ledger['requests']:
        for k in ('input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'):
            tokens[k]+=req.get('usage',{}).get(k,0) or 0
        if req.get('returned_model'):models[req['returned_model']]+=1
    summary.update(tokens=dict(tokens),returned_models=dict(models),
        actual_settled_usd=sum(q['charged_or_reserved_usd'] for q in ledger['requests'] if q['status']=='settled'))
    dump(run/'summary.json',summary)
    dump(run/'repeat_consistency.json',repeat_checks)
    history = load_rows(run, 'historical_baseline')
    development = load_rows(run, 'development_live')
    hgood = sum(q['correct'] for q in history)
    dgood = sum(q['correct'] for q in development)
    imports = read(run/'plan_imports.json') if (run/'plan_imports.json').exists() else []
    historical_ids = {q['id'] for q in history if not q['correct']}
    ambiguity_finding = ('The two historical misses name “Büro” without a ref; the building has three same-named ground-floor rooms and nine on Floor 1. Different candidates give different answers. Both misses remain wrong in the strict score.'
        if historical_ids == {'osm-way37850565-H03','osm-way37850565-H04'} else 'Inspect failure_analysis.json and the historical traces for evidence specific to this run. Preserve every miss in the strict score.')
    lines=['## Decision', '',
        ('All registered final acceptance gates passed.' if all(gates.values()) else 'One or more final acceptance gates are incomplete or failed; see the table below.'),
        ('The baseline and candidate production code are identical. The two fresh-set runs measure independent execution of the same agent; they do not demonstrate an improvement from a model or prompt change.' if summary['paired']['production_code_identical'] else 'Baseline and candidate differ; use the paired regression and improvement records to assess the change.'),
        '', '| Gate | Result |','|---|---|']
    lines += [f'| {k.replace("_"," ")} | {"PASS" if v else "INCOMPLETE / FAIL"} |' for k,v in gates.items()]
    lines += ['', '## Main findings and recommendations', '',
        f'1. **Use measured evidence for model changes.** The historical live run scored {hgood}/{len(history)} ({hgood/max(len(history),1):.2%}). The registered synthetic development run scored {dgood}/{len(development)}. This audit did not compare alternative agent models.',
        f'2. **Resolve ambiguous source room names when preparing new judge questions.** {ambiguity_finding} In chat, ask for a room number. Do not hard-code hidden expected rooms or tune a majority rule to historical labels.',
        f'3. **Treat missing plan metadata as an explicit limitation.** Across {len(imports)} SVG imports, matched spaces: {sum(x["rooms_matched"] for x in imports)}/{sum(x["rooms_total"] for x in imports)}; opening pairs: {sum(x["opening_pairs_correct"] for x in imports)}/{sum(x["opening_pairs_total"] for x in imports)}; connector flights: {sum(x["connector_flights_correct"] for x in imports)}/{sum(x["connector_flights_total"] for x in imports)}. These are generated plans in the supported drawing style. Door widths, room types and elevations were absent; defaults are not measured facts. The importer is not a general PNG/PDF plan-understanding system. Show the builder collecting those facts before claiming accurate accessibility or distances.',
        '4. **Shorten spoken/chat directions.** The wheelchair conversation used long numbered lists even though the chat prompt asks for short prose. Give the destination, route constraint and next two actions; retain the full route on the map. This is a presentation recommendation, not a benchmark failure or a production change made during this audit.',
        '5. **Keep the new audit for future changes.** Validate new work on new seeds. The final seed from this run is now consumed and must never be presented as newly blind again.',
        '', '## Evidence limits', '',
        '- Official test accuracy cannot be measured without the organizer’s hidden labels. Submission format validation and repeated-answer agreement are not substitute accuracy measures.',
        '- Synthetic buildings were generated independently of production code, but share a corridor/room/shaft construction vocabulary. They cover the registered layout families and specified constraints; they do not establish robustness to all real-world buildings or arbitrary drawings.',
        '- The geometry oracle independently implements the README definitions using Shapely; the routing oracle intentionally uses the organizer’s frozen router. Shared library/reference defects remain possible. Analytical checks cover polygon arithmetic, stair/lift cost, width thresholds, disconnected entrances, and a known new-door route.',
        '- Translation, renamed IDs and reordered records were checked offline against the production engine. Live questions use newly worded templates, but this audit did not run a large paraphrase or multilingual study.',
        '- Conversation checks exercised the agent and session state. Maintenance delivery used a stub; the browser, microphone, external notification delivery and real building safety were not evaluated.',
        '- The Anthropic SDK’s automatic retries were disabled for metering. Production retry behavior was not stress-tested; operational errors, if any, remain in their cohort denominators.',
        '- A zero-error cluster bootstrap degenerates to a 100%–100% interval. It is not proof of perfect generalization. The building-level interval below describes the fraction of generated buildings with every selected benchmark question correct, under a sampling approximation; it is a different metric from question accuracy.',
        '']
    ci=summary['final_benchmark']['building_all_correct_wilson_95']
    if ci:lines += [f'Fresh benchmark building success: **{building_all}/{buildings}**, descriptive Wilson 95% interval **{ci[0]:.1%}–{ci[1]:.1%}**. There are only ten questions per skill.','']
    lines += ['## Cost and reproducibility','',
        f'Actual metered API cost: **${summary["actual_settled_usd"]:.4f}**. Charges plus unresolved reservations: **${summary["charged_or_reserved_usd"]:.4f}**. The $100 ceiling includes all recorded calls.',
        f'Returned models: `{dict(models)}`.',
        f'Token usage: `{dict(tokens)}`.',
        'Prices were verified against https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5 on 2026-10-25: input $4/M, output $20/M, five-minute cache writes $5/M, cache reads $0.20/M. This cost covers FINNI API calls, not the Codex subscription used for the auditor.',
        'The manifest stores source/dependency/data hashes, baseline commit, organizer revision, seeds and thresholds. `ledger.json` records every API request without credentials. `logs/` contains tool traces. `failure_analysis.json` retains the two historical failures.',
        'A preflight harness error used the wrong HTTP library before any requests were sent. Those setup errors are retained under `harness_errors/` and are excluded from agent accuracy. No paid agent failures were silently removed.',
        '']
    with (run/'REPORT.md').open('a') as f:f.write('\n'.join(lines))
    return summary
