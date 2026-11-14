#!/usr/bin/env bash
# Keeps the server on the newest main: every 5 minutes (autodeploy.timer) it fetches GitHub, and
# when main has moved it pulls and rebuilds what changed, then says so in Telegram. This replaces
# the "git pull && docker compose up -d --build render-worker" step after every merge.
#
# Installed once with: sudo bash /opt/percapita/app/tools/autodeploy/install.sh
# Turn it off with:    sudo systemctl disable --now percapita-autodeploy.timer
set -uo pipefail

ROOT=/opt/percapita
APP=$ROOT/app
exec 9>/run/percapita-autodeploy.lock
flock -n 9 || exit 0   # a rebuild is still running

# Telegram: the same bot and chat as the worker.
TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$APP/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')
CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' "$APP/.env" | tail -1 | cut -d= -f2- | tr -d '"'"'"'\r')
tell() {
  [ -n "$TOKEN" ] && [ -n "$CHAT" ] || return 0
  curl -s -m 20 "https://api.telegram.org/bot$TOKEN/sendMessage" \
    --data-urlencode "chat_id=$CHAT" --data-urlencode "text=$1" -d parse_mode=HTML >/dev/null || true
}

# n8n workflows in n8n/workflows/auto/ install themselves: each new or changed file is imported with
# the credentials the live workflows already use (n8n-prepare.py reads only their ids), published,
# and n8n restarted so it takes effect. The worker is told which ones are in (it waits for WF7 before
# swapping a scheduled video). Runs before the "nothing new" exit, so a file that arrived with the
# previous update is installed on the next run.
n8n_auto() {
  local STATE=/var/lib/percapita-autodeploy TMPD f sum id names=() files=() sums=()
  mkdir -p "$STATE"
  for f in "$APP"/n8n/workflows/auto/*.json; do
    [ -e "$f" ] || continue
    sum=$(sha256sum "$f" | cut -c1-64)
    [ "$(cat "$STATE/$(basename "$f").sha" 2>/dev/null)" = "$sum" ] && continue
    files+=("$f"); sums+=("$sum")
  done
  [ ${#files[@]} -eq 0 ] && return 0
  TMPD=$(mktemp -d)
  local FAIL=""
  (cd "$ROOT" && docker compose exec -T n8n n8n export:workflow --all >"$TMPD/live.json" 2>>"$TMPD/err") || FAIL="could not read the live workflows"
  local i
  for i in "${!files[@]}"; do
    [ -n "$FAIL" ] && break
    f=${files[$i]}
    python3 "$APP/tools/autodeploy/n8n-prepare.py" "$f" "$TMPD/live.json" >"$TMPD/ready.json" 2>>"$TMPD/err" || { FAIL="$(basename "$f"): $(tail -1 "$TMPD/err")"; break; }
    id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["id"])' "$TMPD/ready.json")
    names+=("$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[0]["name"])' "$TMPD/ready.json")")
    (cd "$ROOT" && docker compose exec -T n8n sh -c 'cat > /tmp/percapita-auto-wf.json' <"$TMPD/ready.json" \
      && docker compose exec -T n8n n8n import:workflow --input=/tmp/percapita-auto-wf.json \
      && docker compose exec -T n8n n8n publish:workflow --id="$id" \
      && docker compose exec -T n8n rm -f /tmp/percapita-auto-wf.json) >>"$TMPD/err" 2>&1 || FAIL="$(basename "$f"): import or publish failed"
  done
  if [ -z "$FAIL" ]; then
    (cd "$ROOT" && docker compose restart n8n) >>"$TMPD/err" 2>&1 || FAIL="restarting n8n failed"
    # n8n answers 404 on its webhooks until it has started its workflows: wait for that (up to 3 min).
    local t
    for t in $(seq 1 36); do
      (cd "$ROOT" && docker compose exec -T n8n node -e \
        "fetch('http://localhost:5678/healthz/readiness').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))") >/dev/null 2>&1 && break
      sleep 5
    done
    sleep 20
  fi
  { echo "== $(date -u +%FT%TZ) n8n auto: ${names[*]} ${FAIL:-ok}"; cat "$TMPD/err"; } >>/var/log/percapita-autodeploy.log
  rm -rf "$TMPD"
  if [ -n "$FAIL" ]; then
    # Say it once per version of the files, then keep retrying quietly every 5 minutes.
    local key; key=$(printf '%s' "${sums[*]}" | sha256sum | cut -c1-64)
    if [ "$(cat "$STATE/n8n-auto.failed" 2>/dev/null)" != "$key" ]; then
      echo "$key" >"$STATE/n8n-auto.failed"
      tell "⚠️ Installing an n8n workflow by itself failed ($FAIL). Claude can read the details in /var/log/percapita-autodeploy.log; it tries again every 5 minutes."
    fi
    return 1
  fi
  for i in "${!files[@]}"; do echo "${sums[$i]}" >"$STATE/$(basename "${files[$i]}").sha"; done
  rm -f "$STATE/n8n-auto.failed"
  local list; list=$(printf '"%s",' "${names[@]}"); list="[${list%,}]"
  (cd "$ROOT" && docker compose exec -T render-worker node -e \
    "fetch('http://localhost:'+(process.env.PORT||8080)+'/n8n/installed',{method:'POST',headers:{'Content-Type':'application/json'},body:process.argv[1]}).catch(()=>{})" \
    "{\"workflows\":$list}") >/dev/null 2>&1 || true
  tell "🧩 n8n workflow installed and switched on by itself: ${names[*]}"
}

cd "$APP" || exit 1
n8n_auto
cd "$APP" || exit 1
git fetch -q origin main || exit 0   # GitHub unreachable: try again next time
OLD=$(git rev-parse HEAD)
NEW=$(git rev-parse origin/main)
[ "$OLD" = "$NEW" ] && exit 0

CHANGED=$(git diff --name-only "$OLD" "$NEW")

# Restarting the worker mid-render would kill that video, so wait until its work lane is empty.
if echo "$CHANGED" | grep -qE '^(worker/|sql/|music/|compose\.pipeline\.yml$)'; then
  BUSY=$(cd "$ROOT" && docker compose exec -T render-worker node -e \
    "fetch('http://localhost:'+(process.env.PORT||8080)+'/health').then(r=>r.json()).then(h=>console.log(h.queue.running.length+h.queue.waiting.length)).catch(()=>console.log(0))" 2>/dev/null | tr -dc 0-9)
  [ "${BUSY:-0}" -gt 0 ] && exit 0   # busy: try again in 5 minutes
fi

TITLES=$(git log --format='• %s' --no-merges "$OLD..$NEW" | head -8)
if ! git merge -q --ff-only origin/main 2>/tmp/percapita-autodeploy.err; then
  tell "⚠️ Auto-update stopped: the server's copy of the code has local changes, so it can't move to the newest version.
<pre>$(head -c 600 /tmp/percapita-autodeploy.err)</pre>"
  exit 1
fi

cd "$ROOT" || exit 1
LOG=/var/log/percapita-autodeploy.log
{ echo "== $(date -u +%FT%TZ) $OLD -> $NEW"; echo "$CHANGED"; } >>"$LOG"
STATUS=0
if echo "$CHANGED" | grep -qE '^compose\.pipeline\.yml$'; then
  docker compose up -d --build >>"$LOG" 2>&1 || STATUS=$?
elif echo "$CHANGED" | grep -qE '^(worker/|sql/|music/)'; then
  docker compose up -d --build render-worker >>"$LOG" 2>&1 || STATUS=$?
fi

if [ "$STATUS" -ne 0 ]; then
  tell "⚠️ Auto-update to the newest code failed while rebuilding (the old version keeps running). Claude can read the reason in /var/log/percapita-autodeploy.log.
$TITLES"
  exit 1
fi

NOTE=""
if echo "$CHANGED" | grep -qE '^n8n/workflows/[^/]+\.json$'; then
  NOTE="
An n8n workflow file changed too; that one still needs its own re-import (Claude will say if it matters)."
fi
tell "🔄 Server updated to the newest code:
$TITLES$NOTE"
