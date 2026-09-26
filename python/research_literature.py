#!/usr/bin/env python3
"""Conservative external literature stage for CodeBase1 RSI.

Uses OpenAlex public metadata only; no benchmark files, labels, accession maps,
or candidate worktrees are read. A production campaign should pin/export the
returned metadata and review source quality before allowing a planner to use it.
"""
from __future__ import annotations
import json, os, urllib.parse, urllib.request
from pathlib import Path

def main():
    req=json.loads(Path(os.environ['EVIREAD_RSI_RESEARCH_REQUEST']).read_text())
    feedback=req.get('aggregate_feedback') or {}
    query='protein foundation model evidence reading GO function prediction agent recursive self improvement'
    if isinstance(feedback,dict):
        query += ' ' + ' '.join(str(feedback.get(k,'')) for k in ('failure_mode','diagnosis','fusion') if feedback.get(k))
    url='https://api.openalex.org/works?'+urllib.parse.urlencode({'search':query,'per-page':5,'select':'id,title,doi,publication_year,type'})
    try:
        with urllib.request.urlopen(url, timeout=20) as response: data=json.loads(response.read())
        sources=[{'id':x.get('id'),'title':x.get('title'),'doi':x.get('doi'),'year':x.get('publication_year'),'type':x.get('type')} for x in data.get('results',[])]
        limitations=['Metadata-only retrieval; full text was not read.','Sources are research context, not benchmark evidence or labels.']
    except Exception as exc:
        sources=[]; limitations=[f'External literature query unavailable: {type(exc).__name__}.']
    print(json.dumps({'schema':'eviread-rsi-research.v1','query':query,'sources':sources,'insights':['Use literature only to form a falsifiable Read/workflow hypothesis; do not treat it as target-specific evidence.'],'limitations':limitations}))
if __name__=='__main__': main()
