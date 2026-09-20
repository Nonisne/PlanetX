#!/bin/bash

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)" || exit 1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin"

if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    . "$NVM_DIR/nvm.sh" --no-use
    nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  printf '\n未找到 Node.js。请先安装 Node.js 18 或更高版本，然后重新双击脚本。\n'
  exit 1
fi

if ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 18 ? 0 : 1)'; then
  printf '\n当前 Node.js 版本过低，需要 Node.js 18 或更高版本。\n'
  exit 1
fi

entry_file="$1"
shift
cd -- "$project_dir" || exit 1
exec node "$project_dir/$entry_file" "$@"
