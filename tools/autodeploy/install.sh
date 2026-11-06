#!/usr/bin/env bash
# One-time setup of the self-updating server. Run on the VPS:
#   sudo bash /opt/percapita/app/tools/autodeploy/install.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
chmod +x "$HERE/autodeploy.sh"
cat >/etc/systemd/system/percapita-autodeploy.service <<UNIT
[Unit]
Description=Per Capita Maps: pull the newest main and rebuild
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/env bash $HERE/autodeploy.sh
TimeoutStartSec=3600
UNIT
cat >/etc/systemd/system/percapita-autodeploy.timer <<UNIT
[Unit]
Description=Per Capita Maps: check GitHub for a new main every 5 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
UNIT
# git refuses to work in a repo owned by another user when run as root.
git config --global --add safe.directory /opt/percapita/app || true
systemctl daemon-reload
systemctl enable --now percapita-autodeploy.timer
systemctl start percapita-autodeploy.service || true
echo "Auto-update is on. It checks GitHub every 5 minutes; Telegram says when it updates."
