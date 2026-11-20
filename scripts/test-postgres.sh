#!/bin/sh
# Own one disposable PostgreSQL container; never use DATABASE_URL or user data.
set -eu
set +x
umask 077
cd "$(dirname "$0")/.."

for tutorflow_pg_command in docker python3; do
  if ! command -v "$tutorflow_pg_command" >/dev/null 2>&1; then
    echo "PostgreSQL verification requires $tutorflow_pg_command." >&2
    exit 1
  fi
done
if [ -L .data ]; then
  echo 'Refusing to use a symlinked .data directory.' >&2
  exit 1
fi
mkdir -p .data
chmod 700 .data
tutorflow_pg_work=$(mktemp -d "$PWD/.data/postgres-test.XXXXXXXX")
tutorflow_pg_suffix=${tutorflow_pg_work##*.}
tutorflow_pg_owner="tutorflow-pg-test-$tutorflow_pg_suffix"
tutorflow_pg_database="tutorflow_pg_harness_$tutorflow_pg_suffix"
tutorflow_pg_image=postgres:17
tutorflow_pg_cidfile="$tutorflow_pg_work/container.id"

cleanup() {
  tutorflow_pg_status=$?
  trap - 0 HUP INT TERM
  if [ -s "$tutorflow_pg_cidfile" ]; then
    tutorflow_pg_id=$(cat "$tutorflow_pg_cidfile")
    tutorflow_pg_label=$(docker container inspect --format \
      '{{ index .Config.Labels "com.tutorflow.postgres-test-owner" }}' "$tutorflow_pg_id" 2>/dev/null || true)
    if [ "$tutorflow_pg_label" = "$tutorflow_pg_owner" ]; then
      tutorflow_pg_volumes=$(docker container inspect --format \
        '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' \
        "$tutorflow_pg_id" 2>/dev/null || true)
      if docker container rm --force --volumes "$tutorflow_pg_id" >/dev/null; then
        tutorflow_pg_cleanup_ok=true
        tutorflow_pg_volume_count=0
        if docker container inspect "$tutorflow_pg_id" >/dev/null 2>&1; then
          tutorflow_pg_cleanup_ok=false
        fi
        for tutorflow_pg_volume in $tutorflow_pg_volumes; do
          tutorflow_pg_volume_count=$((tutorflow_pg_volume_count + 1))
          if docker volume inspect "$tutorflow_pg_volume" >/dev/null 2>&1; then
            tutorflow_pg_cleanup_ok=false
          fi
        done
        if [ "$tutorflow_pg_cleanup_ok" = true ]; then
          echo "Cleanup verified: owned container $tutorflow_pg_owner and $tutorflow_pg_volume_count volumes removed."
        else
          echo 'Cleanup failed: an owned PostgreSQL container or volume still exists.' >&2
          tutorflow_pg_status=1
        fi
      else
        echo "Could not remove owned container $tutorflow_pg_owner." >&2
        tutorflow_pg_status=1
      fi
    else
      echo 'Cleanup refused an unverified container owner; check the task container manually.' >&2
      tutorflow_pg_status=1
    fi
  fi
  rm -rf "$tutorflow_pg_work"
  exit "$tutorflow_pg_status"
}
trap cleanup 0
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

python3 - "$tutorflow_pg_work/postgres.env" "$tutorflow_pg_database" <<'PY'
from pathlib import Path
import secrets
import sys

Path(sys.argv[1]).write_text(
    'POSTGRES_USER=tutorflow_pg_test\n'
    f'POSTGRES_PASSWORD={secrets.token_hex(32)}\n'
    f'POSTGRES_DB={sys.argv[2]}\n'
)
PY

if ! docker image inspect "$tutorflow_pg_image" >/dev/null 2>&1; then
  docker image pull "$tutorflow_pg_image"
fi
echo "Starting owned synthetic PostgreSQL container $tutorflow_pg_owner."
docker container run --detach --name "$tutorflow_pg_owner" \
  --label "com.tutorflow.postgres-test-owner=$tutorflow_pg_owner" \
  --cidfile "$tutorflow_pg_cidfile" --env-file "$tutorflow_pg_work/postgres.env" \
  --publish 127.0.0.1::5432 "$tutorflow_pg_image" >/dev/null
tutorflow_pg_id=$(cat "$tutorflow_pg_cidfile")
tutorflow_pg_attempt=0
until docker container exec "$tutorflow_pg_id" \
  pg_isready -h 127.0.0.1 -U tutorflow_pg_test -d "$tutorflow_pg_database" >/dev/null 2>&1; do
  tutorflow_pg_attempt=$((tutorflow_pg_attempt + 1))
  if [ "$tutorflow_pg_attempt" -ge 60 ]; then
    echo 'Owned PostgreSQL server did not become ready in 60 seconds.' >&2
    exit 1
  fi
  sleep 1
done
tutorflow_pg_binding=$(docker container port "$tutorflow_pg_id" 5432/tcp)
case "$tutorflow_pg_binding" in
  127.0.0.1:*) tutorflow_pg_port=${tutorflow_pg_binding##*:} ;;
  *) echo 'Refusing a non-loopback PostgreSQL binding.' >&2; exit 1 ;;
esac

python3 - "$tutorflow_pg_work" "$tutorflow_pg_port" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
settings = dict(line.split('=', 1) for line in (root / 'postgres.env').read_text().splitlines())
url = (f"postgresql://{settings['POSTGRES_USER']}:{settings['POSTGRES_PASSWORD']}"
       f"@127.0.0.1:{sys.argv[2]}/{settings['POSTGRES_DB']}")
(root / 'tests.env').write_text(f"TUTORFLOW_TEST_DATABASE_URL='{url}'\n")
assert (root / 'postgres.env').stat().st_mode & 0o777 == 0o600
assert (root / 'tests.env').stat().st_mode & 0o777 == 0o600
PY

echo 'Official PostgreSQL image:'
docker image inspect --format '{{.Id}}' "$tutorflow_pg_image"
echo 'Actual PostgreSQL server version:'
docker container exec "$tutorflow_pg_id" psql -U tutorflow_pg_test \
  -d "$tutorflow_pg_database" -Atc 'SHOW server_version'
set -a
. "$tutorflow_pg_work/tests.env"
set +a
sh scripts/tutorflow.sh exec vitest run tests/postgres.test.ts "$@"
