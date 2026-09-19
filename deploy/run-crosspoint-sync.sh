#!/bin/bash
# Readloop launchd entrypoint for the self-hosted crosspoint-sync (KOSync server
# + Readwise archive-on-finish connector). Config + secrets come from
# .runtime/crosspoint-sync.env (TOKEN_ENC_KEY, PORT, DATABASE_PATH,
# REGISTRATION_DISABLED, FINISHED_THRESHOLD).
#
# NOTE: the crosspoint-sync checkout (~/Dev/readloop/crosspoint-sync) is an
# upstream clone with local mods (the readwise-reader connector, env-configurable
# finish threshold, request/error logging). It's gitignored in the hub; if it's
# ever removed, re-clone + re-apply from proposals/crosspoint-sync/.
set -euo pipefail

ROOT="$HOME/Dev/readloop"

set -a
# shellcheck disable=SC1091
. "$ROOT/.runtime/crosspoint-sync.env"
set +a

# Pinned Node 22 (node:sqlite needs >=22.13; also avoids the system Node).
export PATH="$ROOT/.runtime/node/bin:$PATH"

cd "$ROOT/crosspoint-sync"
exec node dist/index.js
