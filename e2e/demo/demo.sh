#!/bin/sh
# Demo instance for the site captures (docs/): AgentUI + fake agent, on throwaway data.
#   e2e/demo/demo.sh up            starts (server :8181, web build included); credentials demo / demo-pass-123
#   e2e/demo/demo.sh down          stops everything
#   e2e/demo/demo.sh webp <captures> <docs/img>   converts the capture.mjs PNGs to WebP (desktop 1600 px, mobile 600 px)
# Variables: DEMO_DIR (default /tmp/agentui-demo), DEMO_PORT (default 8181).
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
DIR=${DEMO_DIR:-/tmp/agentui-demo}
PORT=${DEMO_PORT:-8181}
TOKEN=demo-token-0123456789abcdef

case "$1" in
  up)
    "$0" down
    mkdir -p "$DIR"; rm -rf "$DIR/data"; mkdir "$DIR/data"
    printf 'agents:\n  - id: atlas\n    type: gateway\n    name: Atlas\n    token: %s\n' "$TOKEN" > "$DIR/agents.yaml"
    (cd "$ROOT/apps/web" && npx vite build >"$DIR/build.log" 2>&1)
    cd "$ROOT/apps/server"
    AGENTS_CONFIG="$DIR/agents.yaml" DATA_DIR="$DIR/data" WEB_DIST="$ROOT/apps/web/dist" ADMIN_USER=demo ADMIN_PASSWORD=demo-pass-123 \
      COOKIE_SECRET=0123456789abcdef0123456789abcdef INSECURE_COOKIES=1 PORT="$PORT" nohup npx tsx src/index.ts >"$DIR/server.log" 2>&1 &
    echo $! > "$DIR/server.pid"
    for i in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$PORT/" && break; sleep 1; done
    cd "$ROOT"
    nohup node e2e/demo/fake-agent.mjs "ws://localhost:$PORT/gateway" "$TOKEN" Atlas >"$DIR/agent.log" 2>&1 &
    echo $! > "$DIR/agent.pid"
    sleep 2
    echo "Demo AgentUI: http://localhost:$PORT (demo / demo-pass-123) — logs in $DIR"
    ;;
  down)
    # npx runs the server in a child process: also stop whatever listens on the port
    for p in $(cat "$DIR/server.pid" "$DIR/agent.pid" 2>/dev/null) $(ss -ltnp 2>/dev/null | grep ":$PORT " | grep -o 'pid=[0-9]*' | cut -d= -f2); do kill "$p" 2>/dev/null || true; done
    rm -f "$DIR/server.pid" "$DIR/agent.pid"
    ;;
  webp)
    mkdir -p "$3"
    for f in "$2"/desktop-*.png; do magick "$f" -resize 1600x -quality 82 "$3/$(basename "${f%.png}").webp"; done
    for f in "$2"/mobile-*.png; do magick "$f" -resize 600x -quality 84 "$3/$(basename "${f%.png}").webp"; done
    cp "$3/desktop-dark-chart.webp" "$3/hero-desktop.webp"; cp "$3/mobile-dark-progress.webp" "$3/hero-mobile.webp"
    ;;
  *) echo "usage: $0 up | down | webp <captures> <docs/img>"; exit 1 ;;
esac
