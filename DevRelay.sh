#!/bin/sh
# Linux and macOS counterpart of DevRelay.exe: prepare the checkout, then start the desktop GUI.
# DevRelay.app runs this script on macOS. `./DevRelay.sh --install-desktop-entry` adds a Linux menu entry.
set -u
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
internal="$root/internal"
state="$internal/.devrelay"
log="$state/launcher.log"
mkdir -p "$state" && chmod 700 "$state"

fail() {
  printf '%s\n' "$1" >>"$log"
  if [ "$(uname)" = Darwin ]; then
    osascript -e "display alert \"DevRelay\" message \"$1\"" >/dev/null 2>&1
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send DevRelay "$1"
  fi
  printf 'DevRelay: %s\n' "$1" >&2
  exit 1
}

if [ "${1:-}" = "--install-desktop-entry" ]; then
  applications="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  mkdir -p "$applications"
  cat >"$applications/devrelay.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=DevRelay
Comment=MCP bridge for this development machine
Exec="$root/DevRelay.sh"
Icon=$internal/assets/devrelay-icon.png
Terminal=false
Categories=Development;
EOF
  printf 'Installed %s\n' "$applications/devrelay.desktop"
  exit 0
fi

# Finder and desktop launchers start with a minimal PATH; borrow the login shell's PATH so
# node, npm, cloudflared, and tailscale resolve the same way they do in a terminal.
shell_path=$("${SHELL:-/bin/sh}" -ilc 'printf "\n__DEVRELAY_PATH__%s\n" "$PATH"' 2>/dev/null </dev/null | sed -n 's/^__DEVRELAY_PATH__//p' | tail -n 1)
PATH="${shell_path:+$shell_path:}$PATH:/opt/homebrew/bin:/usr/local/bin"
export PATH
command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required. Install Node.js, then start DevRelay again."

# One launch at a time, so two launches never run npm ci against the same node_modules.
lock="$state/launcher.lock"
if ! mkdir "$lock" 2>/dev/null; then
  owner=$(cat "$lock/pid" 2>/dev/null || true)
  if [ -n "$owner" ] && kill -0 "$owner" 2>/dev/null; then exit 0; fi
  rm -rf "$lock"
  mkdir "$lock" 2>/dev/null || exit 0
fi
echo $$ >"$lock/pid"
trap 'rm -rf "$lock"' EXIT

cd "$internal" || fail "DevRelay's internal folder is missing."
printf '\n[%s] DevRelay launcher\n' "$(date)" >>"$log"
node gui/prepare.mjs >>"$log" 2>&1
case $? in
  0) ;;
  3) exit 0 ;;
  *) fail "DevRelay could not prepare its dependencies. See $log" ;;
esac
nohup node gui/devrelay-gui.mjs >>"$log" 2>&1 &
