#!/bin/sh
# 把本目录以本地链接方式装进 DSH profile（默认 desktop）。
# 用法： ./install.sh [profile]
set -e

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROFILE="${1:-desktop}"
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"

if [ ! -x "$DSH" ]; then
  echo "找不到 dsh CLI：$DSH" >&2
  exit 1
fi

echo "==> 冒烟测试（先确认代码没坏）"
NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
if [ -x "$NODE" ]; then
  ( cd "$PLUGIN_DIR" && "$NODE" test/purge.test.mjs )
else
  echo "    没找到内置 node，跳过测试"
fi

echo
echo "==> 安装 $PLUGIN_DIR 到 profile '$PROFILE'"
"$DSH" plugin --profile "$PROFILE" add "link:$PLUGIN_DIR"

echo
echo "==> 完成。重启 DSH 后生效（客户端半只在启动时组合）。"
echo "    验证：随便挑一个会话右键 → 菜单最下方应出现「彻底删除…」"
echo "    卸载： $DSH plugin --profile $PROFILE remove dsh-plugin-session-purge"
