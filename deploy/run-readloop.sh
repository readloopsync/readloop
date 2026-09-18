#!/bin/bash
# Readloop launchd entrypoint: runs the Readwise-enabled news2reader fork with a
# pinned Node 22 (the system Node breaks Yarn PnP). Config below; secrets (the
# Readwise token) come from deploy/.env.
set -euo pipefail

ROOT="$HOME/Dev/readloop"

# Secrets (READWISE_TOKEN=...) — kept out of this script and out of git.
set -a
# shellcheck disable=SC1091
. "$ROOT/deploy/.env"
set +a

# Pinned Node 22 toolchain
export PATH="$ROOT/.runtime/node/bin:$PATH"
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Service config
export PORT=7323
export READWISE_IMAGES=transcode
export OPDS_PROVIDERS=readwise

cd "$ROOT/news2reader"
exec corepack yarn start
