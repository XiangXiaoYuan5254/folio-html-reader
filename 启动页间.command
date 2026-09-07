#!/bin/zsh
set -e
PROJECT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
APP_PATH="/Applications/页间.app"
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="$PROJECT_DIR/release/mac-arm64/页间.app"
fi
if [[ -d "$APP_PATH" ]]; then
  /usr/bin/open "$APP_PATH"
else
  cd "$PROJECT_DIR"
  if [[ -x /opt/homebrew/opt/node@22/bin/node ]]; then
    export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
  fi
  npm run dev
fi
