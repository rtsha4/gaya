#!/usr/bin/env bash
# Claude Code Notification hook -> gaya "waiting" (user attention needed).
# Reads hook event JSON on stdin and forwards session_id + cwd if present.

INPUT=$(cat)

PAYLOAD=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
  d=json.load(sys.stdin)
  out={"state":"waiting"}
  if d.get("session_id"): out["session_id"]=d["session_id"]
  if d.get("cwd"): out["cwd"]=d["cwd"]
  if d.get("message"): out["message"]=d["message"]
  print(json.dumps(out))
except Exception:
  print("{\"state\":\"waiting\"}")
' 2>/dev/null || echo '{"state":"waiting"}')

curl -s -X POST -H 'Content-Type: application/json' \
  -d "$PAYLOAD" \
  http://127.0.0.1:39999/state --max-time 1 >/dev/null 2>&1 || true
exit 0
