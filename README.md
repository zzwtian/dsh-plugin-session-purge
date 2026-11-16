# dsh-plugin-session-purge

给 DSH 的会话右键菜单加一条 **「彻底删除…」**——不是归档，是真的把会话从磁盘上擦掉。

选中的会话 → 右键 → 菜单最下方（归档下面，危险色，独立分隔线）→ 确认弹窗 → 消失。

- 版本：**v2.1**（`2.1.0`）——安装脚本跨平台（macOS / Linux / Windows），新增 `install.ps1`
- 上个版本：**v2**（`2.0.0`）——修了暗色主题下确认框「白底白字」的配色 bug
- 目标运行时：DSH `0.2.x`（本机实测 `0.2.2-rc.3`）
- 依赖：零。host 半只用 node 内置模块，浏览器半手写 loader 协议 + `require('react')`
- 测试：`node test/purge.test.mjs`（真实文件擦除 + 路由鉴权 + 客户端菜单契约 + 主题对比度，全绿）

---

## 1. 装上

仓库放哪都行，安装只登记一条 `link:` 指向本地目录。各平台入口：

**macOS / Linux**

```bash
cd ~/Documents/deepseek-harness/default-workspace/plugins/dsh-plugin-session-purge
./install.sh          # 默认 desktop profile
```

**Windows（Git Bash / MSYS2）** —— 同一个脚本，会自动转 `link:` 路径

```bash
cd ~/Documents/deepseek-harness/default-workspace/plugins/dsh-plugin-session-purge
./install.sh
```

**Windows（纯 PowerShell，不需要 bash）**

```powershell
cd $HOME\Documents\deepseek-harness\default-workspace\plugins\dsh-plugin-session-purge
.\install.ps1                       # 默认 desktop profile

# 默认 ExecutionPolicy 是 Restricted 时会被拦，绕过一次：
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`install.ps1` 存成 UTF-8 **带 BOM**。PowerShell 5.1 在 GBK 代码页（936）下按 ANSI 读无 BOM
的脚本，会把中文注释里的字节当成双字节的尾字节，吃掉后面的 `}` 和 `"`，然后报
「语句块中缺少右 `}`」——纯粹是解码问题，不是脚本坏。**别把 BOM 去掉**。

两个脚本做同一件事：跑一遍冒烟测试，然后

```bash
dsh plugin --profile desktop add "link:<本目录>"
```

它们自己找 `dsh` CLI：先看 `PATH`，再看

| 平台 | CLI 落地位置 |
| --- | --- |
| macOS | `DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`（可执行） |
| Windows | `<install>\resources\app\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js`（用 `node` 跑） |
| Linux | 同 Windows 布局，或 `PATH` 上的 `dsh` |

探测不到就显式指定：

```bash
DSH_RESOURCES="/c/Program Files/DeepSeek Harness/resources" ./install.sh
DSH_CLI="C:/path/to/lib/bin.js" ./install.sh
```

```powershell
.\install.ps1 -Resources 'D:\deepseek\resources'
.\install.ps1 -DshCli 'C:\path\to\lib\bin.js'
```

> **`desktop` profile 归 Electron 桌面应用独占管理。** 这种环境下 CLI 直接拒绝：
>
> ```
> error: profile "desktop" is managed exclusively by the Electron application
> ```
>
> 这时别绕 CLI，改走应用内的插件管理器——Settings → 插件，或 agent 侧的
> `plugin_manager` 工具——执行 `install_bundle`，`target` 填 `link:<本目录>`
> （Windows 上用正斜杠，例如 `link:C:/Users/me/plugins/dsh-plugin-session-purge`）。
> 非 desktop 的 profile（`web` / `headless` / 自建）用脚本就行。

`dsh plugin` 只把参数转发给 profile 目录里的 pnpm，然后把包登记进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`——**不需要手写 patch 行**
（patch 层是可选的覆盖层，用来改 config 或换实现）。

实测装完的形状：

```
node_modules/dsh-plugin-session-purge -> .../plugins/dsh-plugin-session-purge   # Windows 上是 Junction
package.json: "dependencies" + "dsh.profile.bundles" 各多一行
```

**必须重启 DSH**——host 半会随 profile 重组合即时生效，但浏览器半只在启动时
组合进前端 bundle；`link:` 只省掉重装，不省重启。

装完验证：挑一个会话右键，菜单最下方应出现「彻底删除…」。

回滚：

```bash
dsh plugin --profile desktop remove dsh-plugin-session-purge     # CLI 管的 profile
```

`desktop` 这类 Electron 独占的 profile 用插件管理器移除 bundle
（`remove_bundle` / Settings → 插件），CLI 那条会同样被拒。

---

## 2. 删除到底删了什么

顺序是刻意的，**不能换**：

```
1. archiveSession(id, { stopActivity: true })          先停活
2. unarchiveSession(id)                                出归档集合（幂等）
3. workspace.detachSession(id)                         从每个 workspace 账本摘掉
4. agent.ctx.fiber.dispose()                           把内存里的活会话请出去（关键）
5. 删 ~/.dsh/sessions/<proj>/session-<id>/             日志 + 锁
6. 删 storages/session_projcache/sessions/<id>.json    冷读缓存
7. 删 storages/dsh-context/overview-cache.v1.json 里的条目
```

第 4 步是「删了但列表还在」的正解：DSH 的会话只有**创建它的 fiber 被 dispose**
才会离开 store，那时 Host 才 emit `session/disposed` → `api-session/removed`，
客户端（包括第三方侧栏）才真正删掉那一行。detach 能力是私有的，但 agent 作用域
fiber 可以 dispose，而 `dsh-agent-loop` 把会话生命周期折进了 agent 的 effect。
必须在删文件之前做：先让它停止写入、离开 store，再抽掉磁盘。
上界 5 秒（`EVICT_TIMEOUT_MS`），超时就继续删文件，不把请求吊死。

为什么每一步都不能少：

| 步 | 不做的后果 |
| --- | --- |
| 1 停活 | 会话正在流式输出时删文件，句柄踩空、日志写坏 |
| 2 出归档 | 归档集合里留下指向空文件的 id，之后 unarchive 出来一个幽灵 |
| 3 摘账本 | 侧栏留一行打不开的僵尸（getter 会按 header 索引过滤，但账本仍是脏的） |
| 4-6 删文件 | 「归档」和「删除」就没区别了 |

第 1 步走的是 DSH 自己的 `workspace/session-stop` 通道，`dsh-agent` 会像你点「停止」那样取消回合，不是硬杀进程。

---

## 3. 安全边界

- **只接受 POST**，路径 `/session-purge`，body 上限 8KB
- **必须通过 `connection.requestRejection(req)`**：拿不到可信会话就 401/403，匿名来源一律拒绝。这是破坏性接口的硬门槛
- **sessionId 正则守卫**：只接受 `session-<uuid>`，拒绝任何路径拼接（`../` 之类进不来）
- **删除前校验路径归属**：只删 `.../sessions/<proj>/session-<id>` 形态的目录，不认别的
- **不手改 `workspace.json`**：账本走 registry 实体方法，避免和内存状态打架

---

## 4. v1 明确不处理的四件事

真删了但**没**清理下面这些，都是独立的小工程，需要就说：

1. **附件对象** `~/.dsh/attachments/` —— 共享 blob，可能被别的会话引用，要引用计数才能安全回收
2. **worktree** —— 0.2.2-rc.1 起归档会清 worktree，删除路径没接这段逻辑
3. **指向该会话的定时任务** —— 会保留，之后触发时报目标不存在；建议删前手动停
4. **子 agent 会话级联** —— 父删子不删，子会变成孤儿

已知行为：

- 删除**当前正在查看**的会话后，标签页会停在空会话上，手动切走即可
- 删除成功后客户端做两步：先 `ctx.sessions.handleSessionRemoved(id)` 本地同步摘掉那一行，
  再 `ctx.sessions.refresh()` 拉一次 Host 基线对齐
- host 若成功 dispose 掉内存里的活会话，DSH 自己会发 `session/disposed` → `api-session/removed`，
  连第三方侧栏（dsh-context 之类）也会跟着删行 —— 不需要重启
- 会话若只被「只读打开」过（没有 agent 作用域可 dispose），Host 内存里仍持有它，
  `listSessions()` 会把 live 会话并进列表，那一行要重启才消失；响应 `warnings` 会写
  `NO_AGENT_SCOPE` / `LIVE_IN_MEMORY`，客户端提示里也会说明

---

## 5. 结构

```
dsh-plugin-session-purge/
├── package.json       # dsh.bundle.patch + dsh.client 双 manifest
├── cordis.patch.yml   # insert 行，httpPath 可配
├── lib/index.js       # host：purgeSession() + POST /session-purge
├── lib/client.js      # 浏览器：菜单项 + 确认浮层（手写 loader 协议，无构建）
├── test/purge.test.mjs
├── install.sh         # macOS / Linux；Windows 走 Git Bash，路径自动转换
└── install.ps1        # Windows 原生入口（纯 PowerShell，不需要 bash）
```

两个半怎么接上的：

- 客户端 `exports.inject = ['contextMenus', 'slots']`，注册 `{ id:'sessionPurge.purge', target:'session', order:700 }`；内置「归档」是 `order:600`，所以我们天然排在它后面
- **坑：cordis 的 `ctx` 是 Proxy**——读一个没写进 `inject` 的服务是**抛错**（`cannot get property "x" without inject`），不是返回 undefined。要读未注入的服务只有一条正路：`ctx.get('x')`。`sessions` 就是这么取的，故意不写进 `inject`，免得某个 profile 缺这个服务时整个插件（连菜单）都不加载
- 点击后走 `fetch('/session-purge', { method:'POST' })`，host 执行并回报告
- 结果用 `contextMenus.notify()` 反馈；失败在弹窗里原样显示

---

## 6. 改配置

`~/.dsh/profiles/desktop/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-plugin-session-purge
      name: 'dsh-plugin-session-purge'
      config:
        httpPath: /session-purge
```

改 `httpPath` 时要同步改 `lib/client.js` 顶部的 `ROUTE`（客户端半没有 config 通道）。

---

## 7. 配色（v2 修过一个真 bug）

v1 的浮层写的是：

```js
background: 'var(--dsw-alias-bg-primary, #ffffff)'
color:      'var(--dsw-alias-label-primary, #111111)'
```

但 **DSH 根本没有 `--dsw-alias-bg-primary` 这个 token**（真实名字是 `bg-base` /
`bg-layer-1..3` / `bg-overlay` / `bg-mask-1..3`），于是背景永远退回硬编码白色；
而 `--dsw-alias-label-primary` 是真存在的，暗色主题下取到 `#f9fafb`。
结果：**白底白字，对话框里所有文字隐形，只剩那颗写死红底白字的「彻底删除」**。

现在的原则一条：**背景和文字必须来自同一套主题**。

| 用途 | token | 暗色实测 | 亮色实测 |
| --- | --- | --- | --- |
| 卡片表面 | `--dsw-alias-bg-layer-2` | `#2c2c2e` | `#ffffff` |
| 主文字 | `--dsw-alias-label-primary` | `#f9fafb` | `#0f1115` |
| 次要文字 | `--dsw-alias-label-secondary` | `#cfd3d6` | — |
| 描边 | `--dsw-alias-border-l2` | 白 12% | 黑 10% |
| 危险按钮 | `--dsw-alias-state-error-primary` | `#f25a5a` | `#ec1313` |
| 遮罩 | `--dsw-alias-bg-mask-1` | 黑 50% | 黑 24% |

表面色 token 取不到时，**整套**退回自洽浅色（`#ffffff` / `#111111`），绝不混搭——
混搭就是这次事故的根因。次要文字也改成用 token 而不是 `opacity` 压暗。

测试里锁死了对比度（WCAG）：暗色正文 **13.3:1**、次要 9.3:1，兜底配色 18.9:1；
外加一条静态守卫，源码里再出现 `--dsw-alias-bg-primary` / `--dsw-shadow-lv3`
这种不存在的 token 直接测试失败。

---

## 8. 版本记录

| 版本 | 日期 | 内容 |
| --- | --- | --- |
| **v2.1**（`2.1.0`） | 2026-11-16 | **安装跨平台**：`install.sh` 自动探测 macOS / Linux / Windows 的 `dsh` CLI 位置，Windows 下把 `link:` 目标转成正斜杠 Windows 路径；新增 `install.ps1`（纯 PowerShell 入口，参数 `-ProfileName` / `-Resources` / `-DshCli`）。README 写明 `desktop` profile 归 Electron 独占管理、CLI 会被拒绝，须改走应用内插件管理器。作者署名 `zzwtian`。 |
| **v2**（`2.0.0`） | 2026-11-15 | **修配色**：确认框改用真实存在的 `--dsw-alias-bg-layer-2` 作表面色，与 `--dsw-alias-label-primary` 同源；次要文字改用 `label-secondary`（不再靠 `opacity` 压暗）；错误色/遮罩改用主题 token。新增 WCAG 对比度回归测试 + 死 token 静态守卫。 |
| v1（`0.1.0`） | 2026-11-15 | 首版：右键「彻底删除…」+ host 端真实擦除（停活 → 出归档 → 摘账本 → dispose 活会话 → 删日志/冷读缓存/概述缓存）。 |

---

## 9. 排错

| 症状 | 处理 |
| --- | --- |
| 右键没有「彻底删除…」 | 没重启；或客户端半组合失败，看控制台 `[session-purge]` |
| 点了报 401 | 请求没带 DSH 的 Web 会话（直接 curl 会这样，属正常） |
| 报 405 | 只支持 POST |
| `error: profile "desktop" is managed exclusively by the Electron application` | 该 profile 由桌面应用独占管理，CLI 改不动它。改用应用内插件管理器（Settings → 插件，或 `plugin_manager` 工具的 `install_bundle`），`target` 填 `link:<本目录>` |
| 删了但侧栏还在 | 客户端快照没刷新：Cmd+R 重载界面；响应 `warnings` 若写着 `still resident in host memory`，说明要重启 DSH |
| 刷新后仍不消失 | 该会话在本次运行中被打开过，重启 DSH 后自然消失 |
| 弹窗只有一颗红按钮、文字全看不见 | v1 的配色 bug：用了不存在的 `--dsw-alias-bg-primary`（背景永远白）配真实的 `--dsw-alias-label-primary`（暗色主题下近白）。v2 起改用 `bg-layer-2` + 同一主题的文字色，重启 DSH 即恢复 |
| 弹窗样式不对 | 主题变量缺失时会整套退回内置浅色配色（保证对比度），功能不受影响 |
