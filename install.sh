#!/bin/sh
# 把本目录以本地链接方式装进 DSH profile（默认 desktop）。
# 用法： ./install.sh [profile]
#
# 平台：macOS / Linux / Windows（Git Bash、MSYS2、Cygwin）。
# 覆盖 CLI 位置：
#   DSH_CLI=/path/to/dsh        ./install.sh [profile]
#   DSH_RESOURCES=/path/to/resources ./install.sh [profile]
#
# 注意：desktop profile 由 Electron 桌面应用独占管理，CLI 会被拒绝
#       （error: profile "desktop" is managed exclusively by the Electron
#       application）。这种环境请改用应用内插件管理器，见 README「1. 装上」。
set -e

PLUGIN_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
PROFILE="${1:-desktop}"
OS=$(uname -s 2>/dev/null || echo unknown)

# --------------------------------------------------------------- 1. 找 dsh CLI
# 三种落地形态：
#   macOS   <app>/Contents/Resources/runtime/cli/bin/dsh                     可直接执行
#   Windows <install>/resources/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js  用 node 跑
#   Linux   同 Windows 布局，或 PATH 上的 dsh
find_dsh() {
  if [ -n "${DSH_CLI:-}" ]; then
    printf '%s\n' "$DSH_CLI"
    return 0
  fi
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return 0
  fi

  # macOS：app bundle 里的可执行 CLI
  for c in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"
  do
    if [ -x "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done

  # Windows / Linux：desktop-runtime 布局里的 bin.js
  for root in \
    "${DSH_RESOURCES:-}" \
    "/c/Program Files/DeepSeek Harness/resources" \
    "/c/Program Files (x86)/DeepSeek Harness/resources" \
    "/d/Program Files/DeepSeek Harness/resources" \
    "/c/Users/${LOGNAME:-${USER:-}}/AppData/Local/Programs/DeepSeek Harness/resources" \
    "/opt/DeepSeek Harness/resources" \
    "/usr/lib/deepseek-harness/resources"
  do
    [ -n "$root" ] || continue
    c="$root/app/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
    if [ -f "$c" ]; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

if ! DSH_PATH=$(find_dsh); then
  cat >&2 <<'EOF'
找不到 dsh CLI。三种办法：
  1) 指应用 resources 目录： DSH_RESOURCES="/c/Program Files/DeepSeek Harness/resources" ./install.sh
  2) 指 CLI 本体：           DSH_CLI="C:/path/to/dsh" ./install.sh
  3) 把 dsh 放到 PATH 上
EOF
  exit 1
fi

run_dsh() {
  case "$DSH_PATH" in
    *.js) node "$DSH_PATH" "$@" ;;
    *)    "$DSH_PATH" "$@" ;;
  esac
}

# --------------------------------------------------------------- 2. 找 node
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE=node
elif [ -x "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" ]; then
  NODE="$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node"
fi

case "$DSH_PATH" in
  *.js)
    if [ -z "$NODE" ]; then
      echo "dsh CLI 是 $DSH_PATH，需要用 node 跑，但没找到 node。" >&2
      exit 1
    fi
    ;;
esac

echo "==> dsh CLI: $DSH_PATH"

# --------------------------------------------------------------- 3. 冒烟测试
echo "==> 冒烟测试（先确认代码没坏）"
if [ -n "$NODE" ]; then
  ( cd "$PLUGIN_DIR" && "$NODE" test/purge.test.mjs )
else
  echo "    没找到 node，跳过测试"
fi

# --------------------------------------------------------------- 4. link 路径
# pnpm 在 Windows 上要 Windows 路径；反斜杠会破坏 link: spec，统一成正斜杠。
LINK_PATH="$PLUGIN_DIR"
case "$OS" in
  MINGW*|MSYS*|CYGWIN*)
    if command -v cygpath >/dev/null 2>&1; then
      LINK_PATH=$(cygpath -w "$PLUGIN_DIR")
    fi
    LINK_PATH=$(printf '%s' "$LINK_PATH" | sed 's|\\|/|g')
    ;;
esac

# --------------------------------------------------------------- 5. 安装
echo
echo "==> 安装 $LINK_PATH 到 profile '$PROFILE'"
if ! run_dsh plugin --profile "$PROFILE" add "link:$LINK_PATH"; then
  cat >&2 <<EOF

安装失败。若上面提到 profile "$PROFILE" is managed exclusively by the
Electron application，说明该 profile 归桌面应用独占管理，CLI 改不动它。
改用应用内的插件管理器（Settings → 插件，或 agent 侧的 plugin_manager 工具）
执行 install_bundle，target 填：

  link:$LINK_PATH
EOF
  exit 1
fi

echo
echo "==> 完成。重启 DSH 后生效（客户端半只在启动时组合）。"
echo "    验证：随便挑一个会话右键 → 菜单最下方应出现「彻底删除…」"
echo "    卸载： $DSH_PATH plugin --profile $PROFILE remove dsh-plugin-session-purge"
echo "           （desktop 这类 Electron 独占的 profile 用插件管理器移除 bundle）"
