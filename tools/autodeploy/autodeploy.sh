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
if echo "$CHANGED" | grep -qE '^n8n/workflows/'; then
  NOTE="
An n8n workflow file changed too; that one still needs its own re-import (Claude will say if it matters)."
fi
tell "🔄 Server updated to the newest code:
$TITLES$NOTE"
