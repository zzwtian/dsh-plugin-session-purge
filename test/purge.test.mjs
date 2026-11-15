/**
 * 冒烟测试：host 半真实擦除 + 路由鉴权，client 半的菜单契约。
 * 不需要 DSH 在跑，不装任何依赖。
 *
 *   node test/purge.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = 'session-11111111-2222-3333-4444-555555555555'
const OTHER_ID = 'session-99999999-8888-7777-6666-555555555555'

/** 造一棵假的 DSH 家目录。 */
async function buildHome() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-purge-home-'))
  const projectKey = '--Users-nobody-demo--'
  const sessionDir = join(home, 'sessions', projectKey, SESSION_ID)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'log-bytes')
  await writeFile(join(sessionDir, 'session.lock'), '')

  const otherDir = join(home, 'sessions', projectKey, OTHER_ID)
  await mkdir(otherDir, { recursive: true })
  await writeFile(join(otherDir, 'session.v4.jsonl.zstd'), 'keep-me')

  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${SESSION_ID}.json`), '{"version":7}')
  await writeFile(join(cacheDir, `${OTHER_ID}.json`), '{"version":7}')

  const contextDir = join(home, 'storages', 'dsh-context')
  await mkdir(contextDir, { recursive: true })
  await writeFile(
    join(contextDir, 'overview-cache.v1.json'),
    JSON.stringify({
      format: 1,
      savedAt: 1,
      sessions: [
        { session: { id: SESSION_ID, title: 'victim' }, identity: { path: join(sessionDir, 'session.v4.jsonl.zstd') } },
        { session: { id: OTHER_ID, title: 'keeper' }, identity: { path: join(otherDir, 'session.v4.jsonl.zstd') } },
      ],
    }),
  )
  return { home, sessionDir, otherDir, cacheDir, contextDir }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/* ---------------------------------------------------------------- host 半 */

const { purgeSession, apply, name: pluginName, inject: pluginInject } = await import('../lib/index.js')

assert.equal(pluginName, 'dsh-plugin-session-purge')
assert.deepEqual(pluginInject, ['webServer'])
console.log('PASS 导出契约 name / inject')

// --- 参数守卫 ---------------------------------------------------------
await assert.rejects(() => purgeSession({}, 'not-a-session'), /invalid session id/)
await assert.rejects(() => purgeSession({}, '../../etc/passwd'), /invalid session id/)
console.log('PASS 会话 id 守卫（拒绝路径穿越）')

// --- 真实擦除 ---------------------------------------------------------
{
  const fixture = await buildHome()
  const calls = []
  const registry = {
    async archiveSession(id, options) {
      calls.push(['archive', id, options])
    },
    async unarchiveSession(id) {
      calls.push(['unarchive', id])
    },
    list() {
      return [
        {
          id: 'ws-1',
          sessionIds: [SESSION_ID, OTHER_ID],
          async detachSession(id) {
            calls.push(['detach', 'ws-1', id])
          },
        },
        {
          id: 'ws-2',
          sessionIds: [OTHER_ID],
          async detachSession() {
            throw new Error('should not be called')
          },
        },
      ]
    },
  }

  const report = await purgeSession({}, SESSION_ID, { home: fixture.home, workspaceRegistry: registry })

  assert.deepEqual(calls[0], ['archive', SESSION_ID, { stopActivity: true }], '必须先停活归档')
  assert.deepEqual(calls[1], ['unarchive', SESSION_ID])
  assert.deepEqual(calls[2], ['detach', 'ws-1', SESSION_ID])
  assert.equal(calls.length, 3, '不该碰不持有该会话的 workspace')

  assert.equal(await exists(fixture.sessionDir), false, '会话日志目录必须消失')
  assert.equal(await exists(join(fixture.cacheDir, `${SESSION_ID}.json`)), false, '冷读缓存必须消失')
  assert.equal(await exists(join(fixture.cacheDir, `${OTHER_ID}.json`)), true, '别的会话缓存不能动')

  const overview = JSON.parse(await readFile(join(fixture.contextDir, 'overview-cache.v1.json'), 'utf8'))
  assert.equal(overview.sessions.length, 1, '概述缓存只删命中项')
  assert.equal(overview.sessions[0].session.id, OTHER_ID)

  assert.equal(await exists(fixture.otherDir), true, '别的会话日志不能动')
  assert.equal(report.sessionId, SESSION_ID)
  assert.equal(report.archived, true)
  assert.deepEqual(report.detachedFrom, ['ws-1'])
  assert.equal(report.removed.length, 3, '日志目录 + 冷读缓存 + 概述缓存条目')
  assert.deepEqual(report.warnings, [])
  console.log('PASS 真实擦除：停活 → 出归档 → 摘账本 → 删日志/缓存/概述')
}

// --- 没有 workspaceRegistry 时降级 -----------------------------------
{
  const fixture = await buildHome()
  const report = await purgeSession({}, SESSION_ID, { home: fixture.home })
  assert.equal(report.archived, false)
  assert.equal(report.warnings.length, 1)
  assert.equal(await exists(fixture.sessionDir), false, 'registry 缺失也要把文件删掉')
  console.log('PASS registry 不可用时降级：只删文件并报告')
}

// --- 内存活会话：先 dispose agent 作用域，再删文件 -------------------
{
  const fixture = await buildHome()
  const order = []
  const liveCtx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: () => ({
            id: SESSION_ID,
            ctx: {
              fiber: {
                async dispose() {
                  // 必须在文件还在的时候 dispose：先让它停止写入，再抽掉磁盘
                  order.push((await exists(fixture.sessionDir)) ? 'dispose:dir-present' : 'dispose:dir-gone')
                },
              },
            },
          }),
        }
      }
      if (name === 'sessions') return { get: () => undefined }
      return undefined
    },
  }
  const report = await purgeSession(liveCtx, SESSION_ID, { home: fixture.home })
  assert.deepEqual(order, ['dispose:dir-present'], 'dispose 必须发生在删文件之前')
  assert.equal(report.evicted, true)
  assert.ok(report.warnings.some((w) => w.startsWith('EVICTED')))
  assert.equal(await exists(fixture.sessionDir), false)
  console.log('PASS 内存活会话：dispose agent 作用域 → 会话离开 store → 再删文件')
}

// --- 活会话但拿不到 agent 作用域时，直接摸 SessionStore 的 entry -------
{
  const fixture = await buildHome()
  const calls = []
  let live = { id: SESSION_ID }
  const store = new Map([[SESSION_ID, { detach() { calls.push('detach'); live = undefined } }]])
  const ctxWithStore = {
    get(name) {
      if (name === 'sessions') return { store, get: () => live }
      return undefined
    },
  }
  const report = await purgeSession(ctxWithStore, SESSION_ID, { home: fixture.home })
  assert.deepEqual(calls, ['detach'], '必须调用 store entry 的 detach()')
  assert.equal(report.evicted, true)
  assert.equal(report.eviction, 'session-store')
  assert.equal(await exists(fixture.sessionDir), false)
  console.log('PASS store 兜底：detach() 让会话离开 store，Host 才会 emit session/disposed')
}

// --- 活会话但没有可 dispose 的 agent 作用域 ---------------------------
{
  const fixture = await buildHome()
  const liveCtx = {
    get(name) {
      if (name === 'agents') return { get: () => ({ id: SESSION_ID }) }
      if (name === 'sessions') return { get: () => ({ id: SESSION_ID }) }
      return undefined
    },
  }
  const report = await purgeSession(liveCtx, SESSION_ID, { home: fixture.home })
  assert.equal(report.evicted, false)
  assert.ok(report.warnings.some((w) => w.startsWith('NO_AGENT_SCOPE')))
  assert.ok(report.warnings.some((w) => w.startsWith('LIVE_IN_MEMORY')))
  assert.equal(await exists(fixture.sessionDir), false, '文件照样要删掉')
  console.log('PASS 无 agent 作用域：文件照删，报告 NO_AGENT_SCOPE + LIVE_IN_MEMORY')
}

// --- 幽灵行：文件已不在 + 内存里还活着 -------------------------------
{
  const fixture = await buildHome()
  // 模拟「同一个会话被点第二次」：日志早就没了
  await rm(fixture.sessionDir, { recursive: true, force: true })
  const liveCtx = {
    get(name) {
      if (name === 'sessions') return { get: () => ({ id: SESSION_ID }) }
      return undefined
    },
  }
  const report = await purgeSession(liveCtx, SESSION_ID, { home: fixture.home })
  assert.equal(report.removed.includes(fixture.sessionDir), false, '日志目录本就不在，不该出现在 removed 里')
  assert.ok(report.warnings.some((w) => w.startsWith('ALREADY_GONE')), '必须报告文件已不存在')
  assert.ok(report.warnings.some((w) => w.startsWith('LIVE_IN_MEMORY')), '必须报告内存里还有残影')
  console.log('PASS 幽灵行：已删过的会话再点一次，报告 ALREADY_GONE + LIVE_IN_MEMORY')
}

/* ---------------------------------------------------------------- HTTP 半 */

function fakeRes() {
  const chunks = []
  return {
    status: 0,
    headers: {},
    writeHead(code, headers) {
      this.status = code
      this.headers = headers ?? {}
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk))
    },
    body() {
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

function fakeReq(method, payload) {
  const body = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]
  return {
    method,
    headers: { host: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of body) yield chunk
    },
  }
}

function mount(routePath, rejection) {
  const registered = []
  const ctx = {
    connection: undefined,
    get(name) {
      if (name === 'connection') return { requestRejection: () => rejection }
      return undefined
    },
    inject(deps, callback) {
      assert.deepEqual(deps, ['webServer'])
      callback({
        webServer: {
          register(route) {
            registered.push(route)
            return () => {}
          },
        },
        effect(run) {
          return run()
        },
      })
    },
    effect(run) {
      return run()
    },
  }
  apply(ctx, { httpPath: routePath })
  assert.equal(registered.length, 1)
  return registered[0]
}

{
  const fixture = await buildHome()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = fixture.home
  try {
    const route = mount('/session-purge', undefined)
    assert.equal(route.kind, 'exact')
    assert.equal(route.path, '/session-purge')

    const ok = fakeRes()
    await route.handler(fakeReq('POST', { sessionId: SESSION_ID }), ok)
    assert.equal(ok.status, 200)
    const payload = JSON.parse(ok.body())
    assert.equal(payload.sessionId, SESSION_ID)
    assert.equal(await exists(fixture.sessionDir), false)

    const get = fakeRes()
    await route.handler(fakeReq('GET'), get)
    assert.equal(get.status, 405)

    const badId = fakeRes()
    await route.handler(fakeReq('POST', { sessionId: 'session-deadbeef' }), badId)
    assert.equal(badId.status, 400)

    const empty = fakeRes()
    await route.handler(fakeReq('POST'), empty)
    assert.equal(empty.status, 400)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  console.log('PASS HTTP 路由：200 / 405 / 400')

  const denied = mount('/session-purge', 401)
  const unauthorized = fakeRes()
  await denied.handler(fakeReq('POST', { sessionId: SESSION_ID }), unauthorized)
  assert.equal(unauthorized.status, 401)
  console.log('PASS HTTP 鉴权：未授权请求被拒（401）')
}

/* ---------------------------------------------------------------- client 半 */

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      captured = config
    },
  },
  addEventListener() {},
  removeEventListener() {},
  confirm() {
    return false
  },
  location: { origin: 'http://127.0.0.1' },
}
const stubReact = {
  createElement: () => null,
  useState: (value) => [value, () => {}],
  useEffect: () => {},
}
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ sessionId: SESSION_ID, warnings: [] }) })

await import('../lib/client.js')
assert.ok(captured !== null, '客户端必须以 __ModuleLoader__.load 注册')
assert.equal(captured.id, 'dsh-plugin-session-purge')
assert.equal(typeof captured.factory, 'function')

const clientModule = captured.factory((id) => {
  if (id === 'react') return stubReact
  throw new Error('unexpected require: ' + id)
})
assert.deepEqual(clientModule.inject, ['contextMenus', 'slots'])

const contributions = []
const slotRegistrations = []
let effectLabels = []
const clientCtx = {
  effect(run, label) {
    effectLabels.push(label)
    return run()
  },
  contextMenus: {
    register(contribution) {
      contributions.push(contribution)
      return () => {}
    },
    notify(text) {
      slotRegistrations.push(['notify', text])
    },
  },
  slots: {
    register(options, component) {
      slotRegistrations.push([options, component])
      return () => {}
    },
    inject(name, callback) {
      assert.ok(['contextMenu.icon', 'shell.overlay'].includes(name), 'unexpected slot: ' + name)
      return callback()
    },
  },
}

clientModule.apply(clientCtx)

assert.equal(contributions.length, 1)
const contribution = contributions[0]
assert.equal(contribution.id, 'sessionPurge.purge')
assert.equal(contribution.target, 'session')
assert.equal(contribution.order, 700)
assert.equal(contribution.order > 600, true, '必须排在归档（600）之后')

const actions = contribution.resolve({ sessionId: SESSION_ID, displayTitle: '初检' }, new AbortController().signal)
assert.equal(actions.length, 1)
assert.equal(actions[0].id, 'purge')
assert.equal(actions[0].label, '彻底删除…')
assert.equal(actions[0].danger, true)
assert.equal(actions[0].separatorBefore, true)
assert.deepEqual(actions[0].icon, { key: 'sessionPurge.trash' })
assert.equal(typeof actions[0].run, 'function')
actions[0].run()

// --- 删除后的行摘除 -----------------------------------------------
{
  const calls = []
  const removalCtx = {
    sessions: {
      handleSessionRemoved(id) {
        calls.push(['removed', id])
      },
      async refresh() {
        calls.push(['refresh'])
      },
    },
  }
  // pluginCtx 是模块级状态，apply 过后指向上一段的 ctx；这里用 __test 直接验证逻辑，
  // 通过临时替换 pluginCtx 不可行，所以走 apply + 触发一次 run 的等价路径：
  // refreshSessionList 读的是 pluginCtx.sessions，因此补一个带 sessions 的 ctx 再调用。
  const previous = clientModule.__test
  assert.equal(typeof previous.refreshSessionList, 'function')
  // 用带 sessions 的上下文重新 apply，覆盖 pluginCtx
  const contributions2 = []
  clientModule.apply({
    effect(run) {
      return run()
    },
    contextMenus: {
      register(contribution) {
        contributions2.push(contribution)
        return () => {}
      },
      notify() {},
    },
    slots: { register() { return () => {} }, inject() {} },
    sessions: removalCtx.sessions,
  })
  await clientModule.__test.refreshSessionList(SESSION_ID)
  assert.deepEqual(calls, [['removed', SESSION_ID], ['refresh']], '必须先本地摘行、再拉 Host 基线')
}

// --- 服务取不到时不能抛 --------------------------------------------------
{
  // cordis 的 ctx 是 Proxy：读没 inject 的服务会抛，而不是返回 undefined。
  // 这里模拟「get 抛 + 属性抛」，确保刷新逻辑整体吞掉，不影响删除结论。
  const hostile = new Proxy(
    {
      effect(run) {
        return run()
      },
      contextMenus: { register: () => () => {}, notify() {} },
      slots: { register: () => () => {}, inject() {} },
      get() {
        throw new Error('cannot get property "sessions" without inject')
      },
    },
    {
      get(target, prop) {
        if (prop in target) return target[prop]
        throw new Error('cannot get property "' + String(prop) + '" without inject')
      },
    },
  )
  clientModule.apply(hostile)
  await clientModule.__test.refreshSessionList(SESSION_ID) // 不得抛出
}

// --- get 优先于属性访问 -------------------------------------------------
{
  const used = []
  const viaGet = new Proxy(
    {
      effect(run) {
        return run()
      },
      contextMenus: { register: () => () => {}, notify() {} },
      slots: { register: () => () => {}, inject() {} },
      get(name) {
        used.push(name)
        if (name === 'sessions') {
          return {
            handleSessionRemoved(id) {
              used.push('removed:' + id)
            },
            async refresh() {
              used.push('refresh')
            },
          }
        }
        return undefined
      },
    },
    {
      get(target, prop) {
        if (prop === 'sessions') throw new Error('property access must not be used')
        return target[prop]
      },
    },
  )
  clientModule.apply(viaGet)
  await clientModule.__test.refreshSessionList(SESSION_ID)
  assert.deepEqual(used, ['sessions', 'removed:' + SESSION_ID, 'refresh'], '必须走 ctx.get("sessions")')
}
console.log('PASS 客户端：未 inject 的服务不再抛错（走 ctx.get），且刷新失败不影响删除结论')
console.log('PASS 客户端：删除后立刻摘掉列表行 + 对齐 Host 基线')

const iconSlot = slotRegistrations.find((entry) => entry[0] && entry[0].name === 'contextMenu.icon')
assert.deepEqual(iconSlot[0], { name: 'contextMenu.icon', key: 'sessionPurge.trash' })
const overlaySlot = slotRegistrations.find((entry) => entry[0] && entry[0].name === 'shell.overlay')
assert.equal(overlaySlot[0].id, 'session-purge-confirm')
assert.equal(typeof overlaySlot[1], 'function')
assert.equal(effectLabels.length, 1)
console.log('PASS 客户端：菜单项（danger/order 700/分隔线）、图标槽、确认浮层槽')

/* ---------------------------------------------------------------- 主题配色 */

// 0.1.0 的真实事故：背景写 `var(--dsw-alias-bg-primary, #fff)`——DSH 根本没有
// 这个 token，于是永远是白底；而 `--dsw-alias-label-primary` 存在，暗色主题下
// 是 #f9fafb。白底白字 → 对话框整块文字隐形。下面用真实 token 值算对比度锁死。

/** WCAG 相对亮度。 */
function luminance(hex) {
  const value = hex.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
  const linear = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** 两色对比度。 */
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** 用一组 token 值假装成宿主的 getComputedStyle。 */
function withTokens(tokens, run) {
  const previous = globalThis.window
  const previousDocument = globalThis.document
  const documentElement = {}
  globalThis.window = {
    getComputedStyle: () => ({ getPropertyValue: (name) => tokens[name] ?? '' }),
    document: { documentElement },
  }
  globalThis.document = { documentElement }
  try {
    return run()
  } finally {
    globalThis.window = previous
    if (previousDocument === undefined) delete globalThis.document
    else globalThis.document = previousDocument
  }
}

const DARK = {
  '--dsw-alias-bg-layer-2': '#2c2c2e',
  '--dsw-alias-label-primary': '#f9fafb',
  '--dsw-alias-label-secondary': '#cfd3d6',
  '--dsw-alias-border-l2': 'rgba(255, 255, 255, 0.12)',
  '--dsw-alias-state-error-primary': '#f25a5a',
  '--dsw-alias-bg-mask-1': '#00000080',
}

{
  const p = withTokens(DARK, () => clientModule.__test.palette())
  assert.equal(p.surface, '#2c2c2e', '必须用真实存在的 bg-layer-2 token')
  assert.equal(p.label, '#f9fafb')
  const body = contrast(p.surface, p.label)
  const note = contrast(p.surface, p.secondary)
  assert.ok(body >= 4.5, '暗色主题正文对比度不足：' + body.toFixed(2))
  assert.ok(note >= 3, '暗色主题次要文字对比度不足：' + note.toFixed(2))
  assert.equal(contrast(p.surface, p.label) < 1.5, false, '白底白字必须不可能出现')
  console.log('PASS 暗色主题：正文对比度 ' + body.toFixed(1) + ':1，次要 ' + note.toFixed(1) + ':1')
}

{
  // token 一个都取不到（未来版本改名 / 测试环境）时，必须整套退回自洽浅色。
  const p = withTokens({}, () => clientModule.__test.palette())
  assert.equal(p.surface, '#ffffff')
  assert.equal(p.label, '#111111')
  assert.ok(contrast(p.surface, p.label) >= 4.5, '兜底浅色对比度不足')
  assert.ok(contrast(p.surface, p.secondary) >= 4.5)
  console.log('PASS 兜底配色：token 全缺时白底黑字 ' + contrast(p.surface, p.label).toFixed(1) + ':1，不会白底白字')
}

{
  // 静态守卫：客户端源码里不得再出现不存在的 token 名（注释除外）。
  const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
  const code = source
    .split('\n')
    .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
    .join('\n')
  for (const dead of ['--dsw-alias-bg-primary', '--dsw-shadow-lv3']) {
    assert.equal(code.includes(dead), false, '不得再引用不存在的 token：' + dead)
  }
  assert.ok(code.includes('--dsw-alias-bg-layer-2'), '必须用真实 token bg-layer-2')
  console.log('PASS 静态守卫：不再引用不存在的主题 token')
}

console.log('\n全部通过：host 擦除 + 路由鉴权 + 客户端菜单契约 + 主题配色对比度')
