#!/usr/bin/env bash
# Cloud-environment setup script for Claude Code on the web (claude.ai/code).
#
# Why: a fresh cloud VM (4 vCPU / 16 GB / 30 GB) needs ~12 minutes to
# cold-compile the engine and its test binaries before any change can be
# verified. Anthropic runs an environment's setup script once, snapshots the
# whole filesystem, and starts every later session from that snapshot until
# the script text or network allowlist changes or ~7 days pass. Anything this
# script leaves on disk OUTSIDE the repository checkout is therefore already
# there in every session.
# Docs: https://code.claude.com/docs/en/cloud-environments#setup-scripts
#
# Use: paste this file's contents into the environment's "Setup script" field,
# or make the field a one-liner (the cache is only rebuilt when the field's
# text changes, so edits to this file take effect at the next cache expiry):
#   curl -fsSL https://raw.githubusercontent.com/ntindle/phase/main/scripts/cloud-setup.sh | bash
#
# What it leaves in the snapshot:
#   /opt/phase-target                    dev-profile artifacts + incremental
#                                        cache for `cargo test -p phase-engine --no-run`
#   ~/.cargo/config.toml                 build.target-dir + build.rustflags, so
#                                        every cargo run inside a session reuses
#                                        that cache with matching fingerprints
#   ~/.cargo/registry, ~/.rustup         crates.io sources + the pinned nightly
#   /opt/phase-cache/MagicCompRules.txt  the gitignored Comprehensive Rules
#                                        text (copy into docs/ in the session)
#   /opt/phase-cache/setup.log           this script's full output
#
# Design notes:
#   * The setup script runs BEFORE the session clones the repository, and the
#     environment-variable panel is not visible to it
#     (anthropics/claude-code#63541). So the script clones its own checkout at
#     the same path a session uses, builds, then removes that checkout so the
#     session's clone can land there. If the path already holds a checkout (a
#     runner that clones first), it is used in place and never deleted.
#   * cargo's artifact hashes do not depend on the checkout path, but rustc's
#     incremental cache is keyed on source paths, so building at the session's
#     path is what makes the post-clone rebuild incremental instead of cold.
#   * It must exit 0 or the session fails to start, so every step is
#     best-effort and logged.
#   * Local testing: PHASE_SETUP_REPO, PHASE_SETUP_WORK, PHASE_SETUP_TARGET,
#     PHASE_SETUP_RUSTFLAGS override the defaults; extra arguments are passed
#     through to cargo. Refuses to run as a non-root user unless
#     PHASE_SETUP_FORCE=1, because it rewrites ~/.cargo/config.toml.

set -u

if [ "$(id -u)" != 0 ] && [ "${PHASE_SETUP_FORCE:-}" != 1 ]; then
  echo "cloud-setup.sh is meant for a throwaway cloud VM (root). Set PHASE_SETUP_FORCE=1 to run anyway." >&2
  exit 0
fi

REPO_URL="${PHASE_SETUP_REPO:-https://github.com/ntindle/phase}"
WORK="${PHASE_SETUP_WORK:-/home/user/phase}"
TARGET="${PHASE_SETUP_TARGET:-/opt/phase-target}"
# -Zthreads enables rustc's parallel front end (nightly). The engine crate is
# ~2M lines in a single crate whose front end is otherwise single-threaded, so
# this is the lever that shortens the cold build on a 4-vCPU VM.
RUSTFLAGS_VALUE="${PHASE_SETUP_RUSTFLAGS:--Zthreads=4}"
CACHE=/opt/phase-cache
MARKER="# phase cloud-setup (scripts/cloud-setup.sh)"

mkdir -p "$CACHE" "$TARGET" "$HOME/.cargo"
exec > >(tee -a "$CACHE/setup.log") 2>&1
echo "=== phase cloud-setup start $(date -u +%FT%TZ) ==="
START=$SECONDS

# 1. Point every cargo invocation in the session at the warm target dir with
#    the same rustflags used here. RUSTFLAGS participates in cargo's
#    fingerprint, so the session must use an identical value or every artifact
#    is rebuilt. Written to the user-level config so it applies regardless of
#    which checkout the session runs cargo in; the repo's own .cargo/config.toml
#    merges on top of it.
CFG="$HOME/.cargo/config.toml"
if ! grep -qF "$MARKER" "$CFG" 2>/dev/null; then
  {
    echo ""
    echo "$MARKER"
    echo "[build]"
    echo "target-dir = \"$TARGET\""
    echo "rustflags = [\"$RUSTFLAGS_VALUE\"]"
  } >> "$CFG"
fi
echo "--- $CFG ---"; cat "$CFG"

# 2. A checkout at the session's path.
CLONED_HERE=0
if [ -d "$WORK/.git" ]; then
  echo "using existing checkout at $WORK"
elif [ -e "$WORK" ]; then
  echo "$WORK exists and is not a git checkout; giving up on the build step"
  exit 0
else
  if git clone --depth 1 "$REPO_URL" "$WORK"; then
    CLONED_HERE=1
  else
    echo "clone of $REPO_URL failed; nothing to warm"
    exit 0
  fi
fi
cd "$WORK" || exit 0
echo "checkout: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

# 3. The pinned nightly from rust-toolchain.toml (rustup auto-installs it).
rustup show active-toolchain || rustup toolchain install || true

# 4. Network-bound side tasks overlap with the compile.
( ./scripts/fetch-comp-rules.sh && cp docs/MagicCompRules.txt "$CACHE/MagicCompRules.txt" ) &
( cd client && pnpm install --frozen-lockfile >/dev/null ) &

# 5. The build that every engine task needs. `cargo test --no-run` compiles the
#    dependency graph, the engine, and its unit + integration test binaries.
#    Not `set -e`: a failed build still leaves partial artifacts worth keeping.
t=$SECONDS
if cargo test -p phase-engine --no-run "$@"; then
  echo "engine test build OK in $((SECONDS - t))s"
else
  echo "engine test build FAILED after $((SECONDS - t))s (partial artifacts kept)"
fi
wait

# 6. Leave the path free for the session's own clone.
if [ "$CLONED_HERE" = 1 ]; then
  cd / && rm -rf "$WORK"
  echo "removed setup checkout $WORK"
fi

echo "target dir: $(du -sh "$TARGET" 2>/dev/null | cut -f1)"
echo "=== phase cloud-setup done in $((SECONDS - START))s ==="
exit 0
