/**
 * dsh-plugin-session-purge — host 半：把「归档」升级成「真的删掉」。
 *
 * DSH 全程没有会话删除 API，只有归档（archiveSession）。所以这里做四件事：
 *   1. 走 Workspace 注册表停活：archiveSession(id, { stopActivity: true })
 *      —— 内部触发 workspace/session-stop，dsh-agent 像用户点停止那样取消回合
 *   2. 出归档集合：unarchiveSession(id)（幂等，避免留下归档残影）
 *   3. 摘账本：每个 Workspace 的 sessionIds 里 detachSession(id)
 *      —— 走实体方法，不手改 workspace.json（registry 内存里有权威状态，会覆盖手改）
 *   4. 真删文件：会话日志目录、冷读缓存、概述缓存条目
 *
 * 只通过一个 HTTP 路由暴露给浏览器半（右键菜单），不做模型工具——入口就是右键。
 */
import process from 'node:process'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { appendFile, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'

export const name = 'dsh-plugin-session-purge'

/** webServer 只有 web/desktop profile 有；connection 用来做请求鉴权。 */
export const inject = ['webServer']

const DEFAULT_PATH = '/session-purge'
const MAX_BODY_BYTES = 8 * 1024
/** 卸载 agent 作用域的等待上界：超时就继续删文件，别把请求吊死。 */
const EVICT_TIMEOUT_MS = 5000
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** DSH 家目录；测试可覆盖。 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * 插件入口：挂一条 POST 路由。
 * @param {any} ctx 插件上下文
 * @param {{ httpPath?: string }} [config] 来自 cordis.patch.yml
 */
export function apply(ctx, config = {}) {
  const routePath = typeof config?.httpPath === 'string' && config.httpPath.startsWith('/')
    ? config.httpPath
    : DEFAULT_PATH

  ctx.inject(['webServer'], (scope) => {
    const dispose = scope.effect(
      () =>
        scope.webServer.register({
          kind: 'exact',
          path: routePath,
          // 返回 promise，让 webServer 能等这次请求真正结算。
          handler: (req, res) =>
            handleRequest(ctx, req, res).catch((error) => {
              console.error('[session-purge] handler failed', error)
              send(res, 500, { error: 'internal', message: String(error?.message ?? error) })
            }),
        }),
      'dsh-plugin-session-purge route',
    )
    console.info(`[session-purge] http ${routePath}`)
    return dispose
  })
}

/* ------------------------------------------------------------------ HTTP */

/**
 * 一条路由的完整请求处理：鉴权 → 方法 → 体积 → 校验 → 执行。
 * @param {any} ctx 插件上下文（用来取 connection / workspaceRegistry）
 * @param {import('node:http').IncomingMessage} req 请求
 * @param {import('node:http').ServerResponse} res 响应
 */
async function handleRequest(ctx, req, res) {
  const connection = ctx.get?.('connection')
  if (typeof connection?.requestRejection !== 'function') {
    send(res, 503, { error: 'unavailable', message: 'host authentication unavailable' })
    return
  }
  // 破坏性操作：只接受带可信会话的请求，绝不对匿名来源开门。
  const rejection = connection.requestRejection(req)
  if (rejection !== undefined) {
    send(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method', message: 'POST only' })
    return
  }

  let body
  try {
    body = await readJson(req)
  } catch (error) {
    send(res, 400, { error: 'bad-request', message: String(error?.message ?? error) })
    return
  }

  const sessionId = body?.sessionId
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    send(res, 400, { error: 'bad-request', message: 'sessionId must be a session-<uuid>' })
    return
  }

  try {
    const report = await purgeSession(ctx, sessionId)
    console.info(`[session-purge] purged ${sessionId} (removed ${report.removed.length}, warnings ${report.warnings.length})`)
    send(res, 200, report)
  } catch (error) {
    send(res, 500, { error: 'purge-failed', message: String(error?.message ?? error) })
  }
}

/** 读取并解析 JSON 请求体，带体积上限。 */
async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk)
  }
  if (size === 0) throw new Error('empty body')
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** 统一的 JSON 响应。 */
function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/* ------------------------------------------------------------------ 核心 */

/**
 * 彻底删除一个会话。顺序不能换：先停活，再出账本，最后删文件。
 *
 * @param {any} ctx 插件上下文（可空；测试可注入 workspaceRegistry）
 * @param {string} sessionId 形如 session-<uuid>
 * @param {{ home?: string, workspaceRegistry?: any }} [options] 测试注入点
 * @returns {Promise<{sessionId:string, archived:boolean, detachedFrom:string[], removed:string[], warnings:string[]}>}
 */
export async function purgeSession(ctx, sessionId, options = {}) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
    throw new Error(`invalid session id: ${String(sessionId)}`)
  }
  const home = options.home ?? dshHome()
  const report = { sessionId, archived: false, evicted: false, eviction: undefined, detachedFrom: [], removed: [], warnings: [] }

  // 1+2+3：停活、出归档集合、摘账本
  const registry = options.workspaceRegistry ?? ctx?.get?.('workspaceRegistry')
  if (registry === undefined || registry === null) {
    report.warnings.push('workspaceRegistry unavailable: skipped stop-activity and ledger cleanup')
  } else {
    try {
      // stopActivity：真正停掉正在跑的回合，而不是拒绝删除
      await registry.archiveSession(sessionId, { stopActivity: true })
      report.archived = true
    } catch (error) {
      report.warnings.push(`archive: ${reason(error)}`)
    }
    try {
      // 幂等：不在集合里就什么都不做
      await registry.unarchiveSession(sessionId)
    } catch (error) {
      report.warnings.push(`unarchive: ${reason(error)}`)
    }
    let workspaces = []
    try {
      workspaces = registry.list() ?? []
    } catch (error) {
      report.warnings.push(`list workspaces: ${reason(error)}`)
    }
    for (const workspace of workspaces) {
      try {
        const ids = workspace.sessionIds ?? []
        if (!Array.isArray(ids) || !ids.includes(sessionId)) continue
        if (typeof workspace.detachSession !== 'function') {
          report.warnings.push(`detach ${String(workspace.id)}: unsupported`)
          continue
        }
        await workspace.detachSession(sessionId)
        report.detachedFrom.push(String(workspace.id))
      } catch (error) {
        report.warnings.push(`detach ${String(workspace?.id)}: ${reason(error)}`)
      }
    }
  }

  // 3.5：把内存里的活会话请出去。
  //
  // 这是「删了但列表还在」的正解：DSH 的会话只有创建它的 fiber 被 dispose 才会
  // 离开 store（那时 Host 会 emit session/disposed → api-session/removed，客户端
  // 才真正删掉那一行）。detach 能力是私有的，但 Agent 作用域 fiber 是可 dispose 的，
  // 而 dsh-agent-loop 把会话生命周期折进了 agent 的 effect —— 所以 dispose 它，
  // 会话跟着离开。必须在删文件之前做：先让它停止写入、离开 store，再抽掉磁盘。
  const eviction = await evictLiveSession(ctx, sessionId)
  report.evicted = eviction.evicted
  report.eviction = eviction.method
  report.warnings.push(...eviction.warnings)

  // 4a：会话日志目录（<home>/sessions/<projectKey>/session-<id>/）
  let logRemoved = false
  const sessionsRoot = join(home, 'sessions')
  for (const projectDir of await readdirSafe(sessionsRoot)) {
    const candidate = join(sessionsRoot, projectDir, sessionId)
    if (!candidate.includes(`${sep}sessions${sep}`) || !candidate.endsWith(`${sep}${sessionId}`)) continue
    if (!(await exists(candidate))) continue
    await rm(candidate, { recursive: true, force: true })
    logRemoved = true
    report.removed.push(candidate)
  }

  // 4b：冷读缓存（<home>/storages/session_projcache/sessions/session-<id>.json）
  const coldCache = join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`)
  if (await exists(coldCache)) {
    await rm(coldCache, { force: true })
    report.removed.push(coldCache)
  }

  // 4c：概述缓存里的条目（按 session.id 或记录的文件路径匹配）
  const overviewPath = join(home, 'storages', 'dsh-context', 'overview-cache.v1.json')
  if (await exists(overviewPath)) {
    try {
      const parsed = JSON.parse(await readFile(overviewPath, 'utf8'))
      const entries = Array.isArray(parsed?.sessions) ? parsed.sessions : null
      if (entries !== null) {
        const kept = entries.filter((entry) => !overviewEntryMatches(entry, sessionId))
        const dropped = entries.length - kept.length
        if (dropped > 0) {
          parsed.sessions = kept
          await writeFile(overviewPath, JSON.stringify(parsed))
          report.removed.push(`${overviewPath} (${dropped} entry)`)
        }
      }
    } catch (error) {
      report.warnings.push(`overview cache: ${reason(error)}`)
    }
  }

  // 5：Host 内存里可能还持有这个会话对象（本次运行中打开过它）。
  // 那一条行会保留到进程重启——这里只如实报告，不强拆 store（detach 能力属于
  // 创建它的 fiber，外面拿不到，硬拆会破坏生命周期不变量）。
  const liveSession = ctx?.get?.('sessions')?.get?.(sessionId)
  if (liveSession !== undefined) {
    report.warnings.push('LIVE_IN_MEMORY: session still resident in host memory; its list row clears only after DSH restarts')
  }
  if (!logRemoved) {
    report.warnings.push('ALREADY_GONE: no session log on disk; nothing left to delete here')
  }

  // 每次擦除留一行 JSONL：排查「行还在」时不用猜，直接看文件。
  await appendDiagnostics(home, {
    at: new Date().toISOString(),
    sessionId,
    evicted: report.evicted,
    eviction: report.eviction,
    detachedFrom: report.detachedFrom,
    removedCount: report.removed.length,
    warnings: report.warnings,
  })

  return report
}

/**
 * 追加一行诊断日志；超过 512KB 就重开文件。写失败不影响删除结论。
 * @param {string} home DSH 家目录
 * @param {Record<string, unknown>} record 要记的内容
 */
async function appendDiagnostics(home, record) {
  try {
    const file = join(home, 'session-purge.log')
    const line = `${JSON.stringify(record)}\n`
    const info = await stat(file).catch(() => undefined)
    if (info !== undefined && info.size > 512 * 1024) await writeFile(file, line)
    else await appendFile(file, line)
  } catch {
    /* 诊断写不进去就算了 */
  }
}

/**
 * 把一个还活在内存里的会话请出去。
 *
 * DSH 里会话离开 store 只有一条正规路径：创建它的 fiber 被 dispose。但很多会话
 * 是被上层控制器 enter 的，插件拿不到那个 detach 能力。于是这里两条腿走：
 *
 *  1. 先试 Agent 作用域：`agent.ctx.fiber.dispose()`（dsh-agent-loop 把会话生命
 *     周期折进了 agent 的 effect，卸载作用域会连带离开 store，还能让 AgentRegistry
 *     正常 emit agent/disposed）。
 *  2. 仍然活着的话，直接摸 SessionStore 内部的 entry 并调用它的 `detach()`。
 *     这是运行时真实存在的字段（`store: Map<SessionId, {detach}>`，名字未混淆），
 *     `detach()` 内部就是 `store.delete(id)` + `emitDisposed`，正是 Host 自己发
 *     `session/disposed` → `api-session/removed` 的路径。属于对私有字段的受控
 *     越界：找不到就退回报告，绝不让删除失败。
 *
 * @param {any} ctx 插件上下文
 * @param {string} sessionId 目标会话
 * @returns {Promise<{ evicted: boolean, method: string | undefined, warnings: string[] }>}
 */
export async function evictLiveSession(ctx, sessionId) {
  const warnings = []
  let method

  const agents = ctx?.get?.('agents')
  const agent = agents?.get?.(sessionId)
  if (agent !== undefined) {
    const fiber = agent?.ctx?.fiber
    if (fiber !== undefined && typeof fiber.dispose === 'function') {
      try {
        const settled = await settleWithin(fiber.dispose(), EVICT_TIMEOUT_MS)
        if (settled === 'timeout') {
          warnings.push('EVICT_TIMEOUT: agent scope dispose did not settle in time')
        } else {
          method = 'agent-scope'
          warnings.push('EVICTED:agent-scope')
        }
      } catch (error) {
        warnings.push(`EVICT_FAILED: ${reason(error)}`)
      }
    } else {
      warnings.push('NO_AGENT_SCOPE: live agent has no disposable scope')
    }
  }

  const sessions = ctx?.get?.('sessions')
  if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined) {
    const entry = findStoreEntry(sessions, sessionId)
    if (entry !== undefined && typeof entry.detach === 'function') {
      try {
        entry.detach()
        method = method === undefined ? 'session-store' : `${method}+session-store`
        warnings.push('EVICTED:session-store')
      } catch (error) {
        warnings.push(`EVICT_STORE_FAILED: ${reason(error)}`)
      }
    } else {
      warnings.push('NO_STORE_ENTRY: session store shape not recognised')
    }
  }

  const stillLive = typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined
  if (stillLive) {
    warnings.push('LIVE_IN_MEMORY: session still resident after eviction; its row clears only after DSH restarts')
  }

  return { evicted: method !== undefined && !stillLive, method, warnings }
}

/**
 * 找到 SessionStore 里那个会话的 entry。
 * 先按已知字段名 `store`（运行时未混淆），再按值扫描所有 Map 兜底。
 * @param {any} sessions SessionStore 服务
 * @param {string} sessionId 目标会话
 * @returns {any}
 */
function findStoreEntry(sessions, sessionId) {
  try {
    const store = sessions.store
    if (store instanceof Map && store.has(sessionId)) return store.get(sessionId)
  } catch {
    /* 形态变了就走下面的扫描 */
  }
  try {
    for (const key of Object.keys(sessions)) {
      const value = sessions[key]
      if (value instanceof Map && value.has(sessionId)) return value.get(sessionId)
    }
  } catch {
    /* 扫描失败就当作找不到 */
  }
  return undefined
}

/** 概述缓存条目是否属于这个会话。 */
function overviewEntryMatches(entry, sessionId) {
  if (entry?.session?.id === sessionId) return true
  const path = entry?.identity?.path
  return typeof path === 'string' && path.includes(`${sep}${sessionId}${sep}`)
}

/* ------------------------------------------------------------------ 小工具 */

function reason(error) {
  return String(error?.message ?? error)
}

/**
 * 等一个 promise，最多等 ms 毫秒。
 * @param {Promise<unknown>} promise 要等的操作
 * @param {number} ms 上界
 * @returns {Promise<'settled' | 'timeout'>}
 */
function settleWithin(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('timeout'), ms)
    if (typeof timer?.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      () => {
        clearTimeout(timer)
        resolve('settled')
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function readdirSafe(path) {
  try {
    return await readdir(path)
  } catch {
    return []
  }
}
