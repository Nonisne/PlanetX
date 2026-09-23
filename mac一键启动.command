#!/bin/zsh

/bin/bash "${0:A:h}/scripts/run-node.sh" start.mjs --open "$@"
exit_code=$?
if [[ $exit_code -ne 0 && -t 0 ]]; then
  read -r "reply?启动未完成，按回车关闭窗口…"
fi
exit "$exit_code"
