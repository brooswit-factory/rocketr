#!/usr/bin/env bash
# Idempotent install of the rocketr systemd --user unit (same shape as bakr's installer).
# Does NOT start the service: `systemctl --user start rocketr` is a separate, explicit step.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$REPO_ROOT/systemd/rocketr.service"
UNIT_DEST_DIR="$HOME/.config/systemd/user"
UNIT_DEST="$UNIT_DEST_DIR/rocketr.service"
ENTRY_POINT="$REPO_ROOT/src/index.ts"
BUN_PATH="$(command -v bun || true)"

[[ -f "$UNIT_SRC" ]] || { echo "error: unit template not found at $UNIT_SRC" >&2; exit 1; }
[[ -n "$BUN_PATH" ]] || { echo "error: no \`bun\` on PATH — install bun and re-run" >&2; exit 1; }
[[ -f "$ENTRY_POINT" ]] || { echo "error: entry point missing: $ENTRY_POINT" >&2; exit 1; }
[[ -d "$REPO_ROOT/node_modules" ]] || { echo "error: dependencies not installed — run \`bun install\` in $REPO_ROOT first" >&2; exit 1; }

# Make a value safe inside a double-quoted systemd argument: escape \ and ", double % (specifier).
escape_systemd_arg() { local v=$1; v="${v//\\/\\\\}"; v="${v//\"/\\\"}"; v="${v//%/%%}"; printf '%s' "$v"; }
# Then make it safe as a sed replacement (& and \).
escape_sed_replacement() { printf '%s' "$1" | sed -e 's/[\&]/\\&/g'; }

RENDERED_UNIT="$(sed \
  -e "s|@@BUN_PATH@@|$(escape_sed_replacement "$(escape_systemd_arg "$BUN_PATH")")|g" \
  -e "s|@@REPO_ROOT@@|$(escape_sed_replacement "$(escape_systemd_arg "$REPO_ROOT")")|g" \
  "$UNIT_SRC")"

if printf '%s' "$RENDERED_UNIT" | grep -q '@@'; then
  echo "error: unsubstituted placeholder left in the rendered unit — refusing to install" >&2; exit 1
fi

if command -v systemd-analyze >/dev/null 2>&1; then
  VERIFY_TMP="$(mktemp "${TMPDIR:-/tmp}/rocketr-verify-XXXXXX.service")"
  printf '%s\n' "$RENDERED_UNIT" > "$VERIFY_TMP"
  VERIFY_STATUS=0
  VERIFY_OUTPUT="$(systemd-analyze --user verify "$VERIFY_TMP" 2>&1)" || VERIFY_STATUS=$?
  rm -f "$VERIFY_TMP"
  [[ -n "$VERIFY_OUTPUT" ]] && printf '%s\n' "$VERIFY_OUTPUT" >&2
  [[ "$VERIFY_STATUS" -eq 0 ]] || { echo "error: systemd-analyze rejected the rendered unit (exit $VERIFY_STATUS)" >&2; exit 1; }
else
  echo "warning: systemd-analyze not found — skipping the verify guard" >&2
fi

mkdir -p "$UNIT_DEST_DIR"
if [[ -f "$UNIT_DEST" ]] && [[ "$RENDERED_UNIT" == "$(cat "$UNIT_DEST")" ]]; then
  echo "unit already installed and up to date: $UNIT_DEST"
else
  printf '%s\n' "$RENDERED_UNIT" > "$UNIT_DEST"
  echo "installed unit: $UNIT_DEST (ExecStart: $BUN_PATH run $ENTRY_POINT)"
fi

systemctl --user daemon-reload
systemctl --user enable rocketr.service
# Linger makes a user unit start at boot without a login session.
loginctl enable-linger "${USER:-$(id -un)}"

echo
echo "rocketr.service is enabled and will start at boot. It is NOT started yet:"
echo "  systemctl --user start rocketr"
echo "  journalctl --user -u rocketr -f"
