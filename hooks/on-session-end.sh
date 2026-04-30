#!/usr/bin/env bash
# Claude Code SessionEnd hook -> tell gaya to retire this session's mascot.
# We send state=idle plus session_end:true so main.js knows to fade out and
# destroy the window after a short linger.

INPUT=$(cat)

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"idle","session_end":True}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"idle\",\"session_end\":true}")
' 2>/dev/null || echo '{"state":"idle","session_end":true}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
