#!/usr/bin/env bash
# Watchdog: keeps the Next.js dev server (port 3000) alive.
# If it crashes (OOM, hot-reload error, etc.), restarts it after 2s.
# Runs as a detached daemon (via daemonize.py's double-fork pattern).

cd /home/z/my-project

while true; do
  # check if port 3000 is responding
  if curl -sS -m 3 -o /dev/null "http://localhost:3000/" 2>/dev/null; then
    sleep 30
    continue
  fi
  # port down — (re)start the dev server
  echo "[$(date -Iseconds)] dev server down — restarting..." >> /home/z/my-project/dev-watchdog.log
  pkill -9 -f "next dev\|next-server" 2>/dev/null
  sleep 2
  nohup bun run dev > /home/z/my-project/dev.log 2>&1 &
  disown
  # wait for it to come up
  for i in $(seq 1 30); do
    sleep 2
    if curl -sS -m 3 -o /dev/null "http://localhost:3000/" 2>/dev/null; then
      echo "[$(date -Iseconds)] dev server back up" >> /home/z/my-project/dev-watchdog.log
      break
    fi
  done
  sleep 15  # extra settle time
done
