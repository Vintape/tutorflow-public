#!/usr/bin/env bash
# Start the local built app and its dedicated PostgreSQL TCP relay.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

if [[ ! -f .env || ! -f dist/server/index.js || ! -f dist/client/index.html ]]; then
  echo "Local relay requires .env and a built TutorFlow." >&2
  exit 1
fi
for required in node socat ss; do
  command -v "$required" >/dev/null || { echo "Missing required command: $required" >&2; exit 1; }
done

endpoint=$(node --env-file=.env --input-type=module <<'JS'
try {
  const url = new URL(process.env.DATABASE_URL);
  const relay = process.env.DATABASE_RELAY_PORT || '15432';
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      process.env.DATABASE_SSL !== 'true' ||
      !/^[a-z0-9.-]+$/i.test(url.hostname) ||
      !/^\d{1,5}$/.test(relay) || Number(relay) < 1 || Number(relay) > 65535) {
    throw new Error();
  }
  console.log(url.hostname, url.port || 5432, Number(relay));
} catch {
  console.error('Local relay requires a PostgreSQL DNS host, verified TLS, and a valid relay port.');
  process.exitCode = 1;
}
JS
)
read -r database_host database_port relay_port <<< "$endpoint"
if [[ -n $(ss -H -ltn "sport = :$relay_port") ]]; then
  echo "The selected PostgreSQL relay port is already in use." >&2
  exit 1
fi
if [[ -z $(ss -H -ltn 'sport = :2080' | awk '$4 == "127.0.0.1:2080" {print $4}') ]]; then
  echo "The local SOCKS5 listener on 127.0.0.1:2080 is unavailable." >&2
  exit 1
fi

app_pid=
relay_pid=
cleanup() {
  trap '' INT TERM
  if [[ -n $app_pid ]]; then
    kill -TERM "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  if [[ -n $relay_pid ]]; then
    kill -TERM "$relay_pid" 2>/dev/null || true
    wait "$relay_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

socat "TCP4-LISTEN:$relay_port,bind=127.0.0.1,reuseaddr,fork,max-children=10" \
  "SOCKS5-CONNECT:127.0.0.1:2080:$database_host:$database_port,connect-timeout=5" &
relay_pid=$!
for attempt in {1..20}; do
  kill -0 "$relay_pid" 2>/dev/null || { echo "PostgreSQL relay exited at startup." >&2; exit 1; }
  [[ -n $(ss -H -ltn "sport = :$relay_port") ]] && break
  sleep 0.1
done
if [[ -z $(ss -H -ltn "sport = :$relay_port") ]]; then
  echo "PostgreSQL relay did not start listening." >&2
  exit 1
fi

NODE_ENV=development DATABASE_RELAY_PORT="$relay_port" node dist/server/index.js --built &
app_pid=$!
status=0
wait -n -p finished "$app_pid" "$relay_pid" || status=$?
if [[ ${finished:-} == "$app_pid" ]]; then
  app_pid=
elif [[ ${finished:-} == "$relay_pid" ]]; then
  relay_pid=
  echo "PostgreSQL relay exited while TutorFlow was running." >&2
  if [[ $status == 0 ]]; then status=1; fi
fi
exit "$status"
