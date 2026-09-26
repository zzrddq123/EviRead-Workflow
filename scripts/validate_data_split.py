#!/usr/bin/env python3
"""Seal and verify an operator-selected partition; never choose a split implicitly."""
from __future__ import annotations
import argparse
import hashlib
import json
import re
from pathlib import Path

LABELS = ('training', 'validation')
def canonical(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()
def load(path):
    return json.loads(Path(path).read_text())
def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def normalized_sequence(text):
    lines = text.strip().splitlines()
    if not lines or not lines[0].startswith('>') or sum(x.startswith('>') for x in lines) != 1:
        raise ValueError('sequence file must contain exactly one FASTA record')
    seq = re.sub(r'\s', '', ''.join(lines[1:])).upper()
    if not re.fullmatch('[A-Z*]+', seq): raise ValueError('FASTA sequence is empty or invalid')
    return seq

def cases(split, label):
    p = Path(split['proteinsFile']); g = Path(split['goldRoot'])
    if not p.is_absolute() or not g.is_absolute() or p.resolve() != p or g.resolve() != g:
        raise ValueError(f'{label}: paths must be canonical and absolute')
    if not p.is_file() or not g.is_dir(): raise ValueError(f'{label}: proteinsFile/goldRoot missing')
    data = load(p)
    rows = data if isinstance(data, list) else data.get('proteins') if isinstance(data, dict) else None
    if not isinstance(rows, list) or not rows: raise ValueError(f'{label}: non-empty JSON proteins array required')
    inventory = {str(p): digest(p)}; result = []
    def file(value, base, gold=False):
        if not isinstance(value, str) or not value: raise ValueError(f'{label}: missing file path')
        path = (base / value).resolve()
        if gold and not path.is_relative_to(g): raise ValueError(f'{label}: Gold path escapes goldRoot')
        if not path.is_file(): raise ValueError(f'{label}: missing file')
        inventory[str(path)] = digest(path)
        return path
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('proteinId'), str) or not row['proteinId'].strip():
            raise ValueError(f'{label}: proteinId is required')
        sequence = file(row.get('sequence'), p.parent)
        structure = file(row['structure'], p.parent) if row.get('structure') is not None else None
        gold = file(row.get('gold', row.get('goldGoIds')), g, True)
        result.append({'proteinId': row['proteinId'], 'sequence': str(sequence), 'structure': str(structure) if structure else None,
                       'goldGoIds': str(gold), 'sequenceHash': hashlib.sha256(normalized_sequence(sequence.read_text()).encode()).hexdigest(),
                       'structureHash': digest(structure) if structure else None})
    if len({x['proteinId'] for x in result}) != len(result): raise ValueError(f'duplicate protein ID within {label}')
    return result, inventory

def verify(raw, seal=False):
    allowed = {'schemaVersion','splitId','benchmarkId','training','validation','test','partitionPolicy','canonicalHash'}
    if not isinstance(raw, dict) or set(raw)-allowed: raise ValueError('manifest has unknown keys')
    if raw.get('schemaVersion') != 'pi-rsi-data-split-manifest.v1': raise ValueError('unsupported schemaVersion')
    if not isinstance(raw.get('splitId'), str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,95}', raw['splitId']): raise ValueError('invalid splitId')
    if 'benchmarkId' in raw and not isinstance(raw['benchmarkId'], str): raise ValueError('invalid benchmarkId')
    if not seal and raw.get('canonicalHash') != canonical({k:v for k,v in raw.items() if k!='canonicalHash'}): raise ValueError('canonicalHash mismatch')
    policy = raw.get('partitionPolicy')
    if not isinstance(policy, dict) or set(policy)-{'requireDisjointProteinIds','requireDisjointSequenceHashes','requireDisjointStructureHashes'}:
        raise ValueError('partitionPolicy is invalid')
    if policy.get('requireDisjointProteinIds') is not True or policy.get('requireDisjointSequenceHashes') is not True:
        raise ValueError('partitionPolicy must require disjoint protein IDs and sequences')
    if 'requireDisjointStructureHashes' in policy and not isinstance(policy['requireDisjointStructureHashes'], bool): raise ValueError('structure policy is invalid')
    partitions = {}; inventories = {}
    labels = LABELS + (('test',) if raw.get('test') is not None else ())
    for label in labels:
        split = raw.get(label)
        if not isinstance(split, dict) or set(split)-{'proteinsFile','goldRoot','goldAccess','evaluationPhase','fileHashes'}:
            raise ValueError(f'{label}: invalid keys')
        if split.get('goldAccess') != ('developer_allowed' if label=='training' else 'evaluator_only'): raise ValueError(f'{label}: Gold access is invalid')
        allowed_phases = {'training':(None,), 'validation':('during_rsi','after_freeze_only'), 'test':('after_freeze_only',)}[label]
        if split.get('evaluationPhase') not in allowed_phases or (label=='training' and 'evaluationPhase' in split): raise ValueError(f'{label}: evaluationPhase is invalid')
        partitions[label], inventories[label] = cases(split, label)
        if seal: split['fileHashes'] = inventories[label]
        elif split.get('fileHashes') != inventories[label]: raise ValueError(f'{label}: file hash mismatch or inventory mismatch')
    pairs=[('training','validation')]+([] if 'test' not in labels else [('training','test'),('validation','test')])
    for a,b in pairs:
        for key in ('proteinId','sequenceHash') + (('structureHash',) if policy.get('requireDisjointStructureHashes') else ()):
            if {x[key] for x in partitions[a] if x[key]} & {x[key] for x in partitions[b] if x[key]}:
                raise ValueError(f'{key} overlap: {a}/{b}')
        if set(inventories[a]) & set(inventories[b]): raise ValueError(f'file overlap: {a}/{b}')
    if seal: raw['canonicalHash'] = canonical({k:v for k,v in raw.items() if k!='canonicalHash'})
    return partitions

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('manifest', nargs='?'); ap.add_argument('--manifest', dest='manifest_flag')
    ap.add_argument('--seal-output', help='Write a new content-bound manifest from an explicit draft; never overwrites')
    args=ap.parse_args(); path=args.manifest_flag or args.manifest
    if not path: ap.error('a manifest path is required')
    raw=load(path); partitions=verify(raw, seal=bool(args.seal_output))
    if args.seal_output:
        with Path(args.seal_output).open('x') as f: f.write(json.dumps(raw, indent=2, ensure_ascii=False)+'\n')
    print(json.dumps({'ok':True,'splitId':raw['splitId'],'counts':{k:len(v) for k,v in partitions.items()},'canonicalHash':raw['canonicalHash']},indent=2))
if __name__=='__main__': main()
