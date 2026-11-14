#!/bin/zsh
set -eu
PREVIEW_ROOT="${0:A:h}"
for candidate in /opt/homebrew/bin/node "$HOME/.local/bin/node" /usr/local/bin/node; do
  if [[ -x "$candidate" ]]; then
    PREVIEW_NODE="$candidate"
    break
  fi
done
if [[ -z "${PREVIEW_NODE:-}" ]]; then
  print -u2 '未找到 Node.js，请安装项目要求的 Node.js 22。'
  read -r '?按回车关闭…'
  exit 1
fi
if "$PREVIEW_NODE" "$PREVIEW_ROOT/scripts/preview-app.mjs" "$@"; then
  print '\n预览已启动。热重载：pnpm app:preview -- dev'
else
  print -u2 '\n启动未完成，请查看上方说明。没有自动清理 App 数据。'
fi
read -r '?按回车关闭此终端窗口（模拟器会继续运行）…'
