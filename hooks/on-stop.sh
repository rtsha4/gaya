#!/usr/bin/env bash
# Claude Code Stop hook -> gaya "done" (agent finished its turn).
# Reads hook event JSON on stdin and forwards session_id + cwd if present.

INPUT=$(cat)

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"done"}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"done\"}")
' 2>/dev/null || echo '{"state":"done"}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
