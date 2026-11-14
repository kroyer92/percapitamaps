#!/usr/bin/env python3
"""Prepares a workflow from n8n/workflows/auto/ for import (autodeploy.sh, n8n_auto).

Workflow files in the repo carry no credential references, so a plain import leaves their Google
nodes without a login. This gives every node that asks for a credential type the same credential
the live workflows already use for that type (WF3's YouTube login, for example). It only reads the
credential's id and name from n8n's workflow export; no secret is read.

  n8n-prepare.py <workflow.json> <export-of-all-live-workflows.json>  -> prints the prepared JSON
"""
import json
import sys

wf = json.load(open(sys.argv[1]))
raw = open(sys.argv[2]).read()
start = raw.find("[{")
live = json.JSONDecoder().raw_decode(raw[start:])[0] if start >= 0 else []

refs = {}  # credential type -> {id, name}, from workflows other than this one
for w in live:
    if w.get("id") == wf.get("id"):
        continue
    for n in w.get("nodes", []):
        for ctype, ref in (n.get("credentials") or {}).items():
            if isinstance(ref, dict) and ref.get("id"):
                refs.setdefault(ctype, {"id": ref["id"], "name": ref.get("name", "")})

missing = []
for n in wf["nodes"]:
    ctype = n.get("parameters", {}).get("nodeCredentialType")
    if not ctype:
        continue
    if ctype not in refs:
        missing.append(f"{n['name']} ({ctype})")
        continue
    n["credentials"] = {ctype: refs[ctype]}
if missing:
    sys.exit("no live workflow uses a credential for: " + ", ".join(missing))
wf["active"] = False
print(json.dumps([wf]))
