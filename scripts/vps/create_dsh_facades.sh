#!/usr/bin/env bash
# Create the HTTP facades for MCP servers that the OMB facades do not cover:
# ssh, n8n, media, media-devices (and optionally console). Run ON cleo as the
# user that owns the checkouts. The gateway then registers these as remote
# HTTP servers; DSH points at the gateway only.
#
# Ports: ssh 8816, n8n 8817, media 8818, media-devices 8819, console 8820.
set -euo pipefail

PROXY="${HOME}/.local/share/brain-mcp-http/node_modules/.bin/mcp-proxy"
HOST="${FACADE_HOST:-10.10.254.91}"

make_one() {
  local name="$1" port="$2"; shift 2
  local dir="${HOME}/.local/share/${name}-mcp-http"
  local cfg="${HOME}/.config/${name}-mcp-http"
  local unit="${HOME}/.config/systemd/user/${name}-mcp-http.service"
  mkdir -p "$dir" "$cfg"
  [ -s "$cfg/key" ] || { openssl rand -hex 32 > "$cfg/key"; chmod 600 "$cfg/key"; }
  {
    printf '#!/usr/bin/env bash\nset -euo pipefail\n'
    [ "$name" = "n8n" ] && printf 'export N8N_MCP_ENV="/home/craigst/.local/share/dsh-plugins/n8n-mcp/mcp.env"\n'
    [ "$name" = "console" ] && printf 'cd /home/craigst/odysseus\n'
    printf 'exec "%s" --host "%s" --port "%s" --apiKey "$(cat "%s/key")" -- %s\n' \
      "$PROXY" "$HOST" "$port" "$cfg" "$*"
  } > "$dir/run.sh"
  chmod 700 "$dir/run.sh"
  cat > "$unit" <<UNIT
[Unit]
Description=${name} MCP over Streamable HTTP (gateway facade)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$dir/run.sh
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable --now "${name}-mcp-http.service"
  printf 'created %-14s :%s (%s)\n' "$name" "$port" "$(systemctl --user is-active "${name}-mcp-http.service")"
}

make_one ssh 8816 node "${HOME}/.local/share/dsh-plugins/ssh-mcp/ssh-mcp.js"
make_one n8n 8817 node "${HOME}/.local/share/dsh-plugins/n8n-mcp/n8n-mcp.js"
make_one media 8818 node "${HOME}/.local/share/dsh-plugins/media-bridge/media-bridge.js"
make_one media-devices 8819 node "${HOME}/.local/share/dsh-plugins/media-devices/media-devices.js"
# console is optional and currently fails to bind when the Odysseus console
# singleton is already running; enable it only after checking its journal.
# make_one console 8820 "${HOME}/odysseus/venv/bin/python" "${HOME}/odysseus/mcp_servers/console_server.py"
