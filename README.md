# dsh-plugin-session-purge

给 DSH 的会话右键菜单加一条 **「彻底删除…」**——不是归档，是真的把会话从磁盘上擦掉。

选中的会话 → 右键 → 菜单最下方（归档下面，危险色，独立分隔线）→ 确认弹窗 → 消失。

- 目标运行时：DSH `0.2.x`（本机实测 `0.2.2-rc.3`）
- 依赖：零。host 半只用 node 内置模块，浏览器半手写 loader 协议 + `require('react')`
- 测试：`node test/purge.test.mjs`（真实文件擦除 + 路由鉴权 + 客户端菜单契约，全绿）

---

## 1. 装上

```bash
cd ~/Documents/deepseek-harness/default-workspace/plugins/dsh-plugin-session-purge
./install.sh          # 默认 desktop profile
```

它做两件事：跑一遍冒烟测试，然后

```bash
dsh plugin --profile desktop add "link:$PWD"
```

`dsh plugin` 只把参数转发给 profile 目录里的 pnpm，然后把包登记进
`~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`——**不需要手写 patch 行**
（patch 层是可选的覆盖层，用来改 config 或换实现）。

实测装完的形状：

```
node_modules/dsh-plugin-session-purge -> .../plugins/dsh-plugin-session-purge
package.json: "dependencies" + "dsh.profile.bundles" 各多一行
```

**必须重启 DSH**——host 半会随 profile 重组合即时生效，但浏览器半只在启动时
组合进前端 bundle；`link:` 只省掉重装，不省重启。

装完验证：挑一个会话右键，菜单最下方应出现「彻底删除…」。

回滚：

```bash
dsh plugin --profile desktop remove dsh-plugin-session-purge
```

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
└── install.sh
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

## 7. 排错

| 症状 | 处理 |
| --- | --- |
| 右键没有「彻底删除…」 | 没重启；或客户端半组合失败，看控制台 `[session-purge]` |
| 点了报 401 | 请求没带 DSH 的 Web 会话（直接 curl 会这样，属正常） |
| 报 405 | 只支持 POST |
| 删了但侧栏还在 | 客户端快照没刷新：Cmd+R 重载界面；响应 `warnings` 若写着 `still resident in host memory`，说明要重启 DSH |
| 刷新后仍不消失 | 该会话在本次运行中被打开过，重启 DSH 后自然消失 |
| 弹窗样式不对 | 主题变量缺失时会退回内置色值，功能不受影响 |
