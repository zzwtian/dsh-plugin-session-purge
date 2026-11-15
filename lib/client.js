// dsh-plugin-session-purge — 浏览器半：会话右键菜单里的「彻底删除…」+ 二次确认。
//
// 手写 lazy-CJS 模块协议（window.__ModuleLoader__.load + factory），所以不需要
// 任何构建步骤：本文件就是能被 loader 直接求值的产物。只 require('react')，
// 不 import 任何 dsh client 包。
//
// 分工：本文件只负责「问」和「显示结果」；真正的擦除在 host 半的
// POST /session-purge（lib/index.js）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-session-purge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var ROUTE = '/session-purge'
    var ICON_KEY = 'sessionPurge.trash'
    var MENU_ID = 'sessionPurge.purge'
    var OVERLAY_ID = 'session-purge-confirm'

    var React = null
    try {
      React = require('react')
    } catch (error) {
      console.error('[session-purge] react unavailable, falling back to window.confirm: ' + error)
    }

    // 一个插件级小 store：菜单动作写入 pending，浮层组件订阅它。
    var pending = null
    var listeners = new Set()
    var pluginCtx = null

    function emit() {
      for (var listener of Array.from(listeners)) {
        try {
          listener()
        } catch (error) {
          console.error('[session-purge] listener failed: ' + error)
        }
      }
    }

    function openConfirm(target) {
      if (React === null) {
        // 没有 react 也要能删：退化成浏览器原生确认框。
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('彻底删除「' + String(target.displayTitle || target.sessionId) + '」？此操作不可恢复。')) return
          runPurge(target, null, null)
        }
        return
      }
      pending = target
      emit()
    }

    function closeConfirm() {
      pending = null
      emit()
    }

    function notify(text, success) {
      var menus = pluginCtx && pluginCtx.contextMenus
      if (menus && typeof menus.notify === 'function') {
        try {
          menus.notify(text, success, undefined)
          return
        } catch (error) {
          console.error('[session-purge] notify failed: ' + error)
        }
      }
      console.log('[session-purge] ' + text)
    }

    /**
     * 让侧栏重新拉一次 Host 的会话基线。
     *
     * 这一步是「删了但列表还在」的正解：客户端持有一份 session 列表快照，只在
     * 基线拉取或 Host 推送时更新；删除文件不会产生任何事件，所以必须主动
     * refresh，否则那一行会一直留到下次刷新/重启。
     */
    /**
     * 取一个服务：先走 ctx.get()，再退回属性访问。
     *
     * cordis 的 ctx 是 Proxy：访问没写进 inject 的服务会**抛**
     * `cannot get property "x" without inject`——不是返回 undefined。
     * ctx.get() 是官方的不受 inject 约束的读法，所以优先用它；
     * 属性访问只作为兜底并整体 try 住。
     */
    function serviceOf(name) {
      try {
        if (pluginCtx && typeof pluginCtx.get === 'function') {
          var service = pluginCtx.get(name)
          if (service) return service
        }
      } catch (error) {
        /* 没有该服务或 get 不可用：继续兜底 */
      }
      try {
        return pluginCtx ? pluginCtx[name] : null
      } catch (error) {
        return null
      }
    }

    async function refreshSessionList(sessionId) {
      var sessions = serviceOf('sessions')
      if (!sessions) {
        console.warn('[session-purge] sessions service unavailable; list may stay stale until reload')
        return
      }
      // 第一刀：本地直接摘掉那一行。handleSessionRemoved 是 ClientSessions 的
      // 正规接口（Host 会话被移除时走的就是它），同步生效，不用等网络。
      if (typeof sessions.handleSessionRemoved === 'function') {
        try {
          sessions.handleSessionRemoved(sessionId)
        } catch (error) {
          console.warn('[session-purge] local row removal failed: ' + error)
        }
      }
      // 第二刀：再拉一次 Host 基线，把整份列表和真实状态对齐（顺序、计数、状态点）。
      if (typeof sessions.refresh === 'function') {
        try {
          await sessions.refresh()
        } catch (error) {
          console.warn('[session-purge] session list refresh failed: ' + error)
        }
      }
    }

    /**
     * 调用 host 路由并处理结果。
     * @param target 被点击的会话
     * @param onBusy 开始/结束状态回调（无 react 时传 null）
     * @param onError 失败文案回调（无 react 时传 null）
     */
    async function runPurge(target, onBusy, onError) {
      if (onBusy) onBusy(true)
      try {
        var response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: target.sessionId }),
          credentials: 'same-origin',
        })
        var payload = null
        try {
          payload = await response.json()
        } catch (error) {
          payload = null
        }
        if (!response.ok) {
          var message = (payload && (payload.message || payload.error)) || ('HTTP ' + response.status)
          throw new Error(String(message))
        }
        var title = String(target.displayTitle || target.sessionId)
        var warnings = payload && Array.isArray(payload.warnings) ? payload.warnings : []
        var ghost = warnings.some(function (w) {
          return typeof w === 'string' && w.indexOf('LIVE_IN_MEMORY') === 0
        })
        var alreadyGone = warnings.some(function (w) {
          return typeof w === 'string' && w.indexOf('ALREADY_GONE') === 0
        })
        closeConfirm()
        // 先摘行 + 对齐基线，再提示，避免用户盯着「还在」的那一行看到「已删除」。
        // 这一步只影响界面：它失败也绝不能把「已经删掉」说成「删除失败」。
        try {
          await refreshSessionList(target.sessionId)
        } catch (error) {
          console.warn('[session-purge] list sync after purge failed: ' + error)
        }
        var suffix = ghost
          ? '（它在内存里还有残影，重启 DSH 后从列表消失）'
          : alreadyGone
            ? '（文件早已不存在，这一行是内存残影，重启后消失）'
            : ''
        notify('已彻底删除「' + title + '」' + suffix, true)
        if (payload && Array.isArray(payload.warnings) && payload.warnings.length > 0) {
          console.warn('[session-purge] warnings: ' + payload.warnings.join(' | '))
        }
      } catch (error) {
        var text = String((error && error.message) || error)
        console.error('[session-purge] purge failed: ' + text)
        if (onError) onError(text)
        else notify('删除失败：' + text, false)
      } finally {
        if (onBusy) onBusy(false)
      }
    }

    /* ---------------------------------------------------------------- 浮层 */

    /**
     * 读一个宿主主题 token 的当前值。
     * 取不到（token 不存在 / getComputedStyle 不可用）就返回 fallback。
     */
    function tokenValue(name, fallback) {
      try {
        // document 在浏览器里是全局的；测试环境可能只挂在 window 上，两种都认，
        // 免得裸引用 document 抛 ReferenceError 把整次取色废掉。
        var doc = typeof document !== 'undefined' && document ? document : window.document
        var computed = window.getComputedStyle(doc.documentElement)
        var value = computed.getPropertyValue(name)
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      } catch (error) {
        /* 没有 document / getComputedStyle：走 fallback */
      }
      return fallback
    }

    /**
     * 解析当前主题下这套浮层要用的颜色。
     *
     * 血泪教训（0.1.0 的 bug）：这里曾经写
     *   background: var(--dsw-alias-bg-primary, #ffffff)
     *   color:      var(--dsw-alias-label-primary, #111111)
     * 但 DSH **没有** --dsw-alias-bg-primary 这个 token（真实名字是
     * bg-base / bg-layer-1..3 / bg-overlay），于是背景永远退回硬编码白色；
     * 而 --dsw-alias-label-primary 是真存在的，暗色主题下它的值是
     * #f9fafb（近白）—— 白底 + 白字，对话框里所有文字隐形，只剩那颗
     * 写死红底白字的「彻底删除」按钮看得见。
     *
     * 所以原则是：**背景和文字必须来自同一套主题**。表面色 token 取不到时，
     * 整套退回自洽的浅色硬编码，绝不把「白色 fallback」和「主题文字色」混搭。
     */
    function palette() {
      var surface = tokenValue('--dsw-alias-bg-layer-2', '')
      if (surface === '') {
        return {
          surface: '#ffffff',
          label: '#111111',
          secondary: '#55575c',
          border: 'rgba(0, 0, 0, 0.12)',
          danger: '#ec1313',
          dangerText: '#ffffff',
          backdrop: 'rgba(0, 0, 0, 0.32)',
        }
      }
      return {
        surface: surface,
        label: tokenValue('--dsw-alias-label-primary', '#111111'),
        secondary: tokenValue('--dsw-alias-label-secondary', '#55575c'),
        border: tokenValue('--dsw-alias-border-l2', 'rgba(0, 0, 0, 0.12)'),
        danger: tokenValue('--dsw-alias-state-error-primary', '#ec1313'),
        dangerText: '#ffffff',
        backdrop: tokenValue('--dsw-alias-bg-mask-1', 'rgba(0, 0, 0, 0.32)'),
      }
    }

    function backdropStyle(p) {
      return {
        position: 'fixed',
        inset: '0',
        zIndex: 2147483000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: p.backdrop,
        pointerEvents: 'auto',
        fontFamily: 'var(--dsw-font-family, system-ui, -apple-system, sans-serif)',
      }
    }

    function cardStyle(p) {
      return {
        width: '380px',
        maxWidth: 'calc(100vw - 32px)',
        boxSizing: 'border-box',
        borderRadius: '14px',
        padding: '18px 18px 14px',
        background: p.surface,
        color: p.label,
        border: '1px solid ' + p.border,
        boxShadow: '0 18px 48px rgba(0, 0, 0, 0.28)',
        fontSize: '13px',
        lineHeight: '20px',
      }
    }

    function buttonStyle(p, kind, disabled) {
      var base = {
        height: '32px',
        padding: '0 14px',
        borderRadius: '8px',
        font: 'inherit',
        fontSize: '13px',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? '0.55' : '1',
        transition: 'background-color .12s ease, border-color .12s ease',
      }
      if (kind === 'danger') {
        base.border = '1px solid transparent'
        base.background = p.danger
        base.color = p.dangerText
        base.fontWeight = '600'
      } else {
        base.border = '1px solid ' + p.border
        base.background = 'transparent'
        base.color = p.label
      }
      return base
    }

    function PurgeConfirm() {
      var h = React.createElement
      var state = React.useState(pending)
      var target = state[0]
      var setTarget = state[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var errorState = React.useState(null)
      var error = errorState[0]
      var setError = errorState[1]

      React.useEffect(function () {
        function sync() {
          setTarget(pending)
          if (pending === null) {
            setError(null)
            setBusy(false)
          }
        }
        listeners.add(sync)
        return function () {
          listeners.delete(sync)
        }
      }, [])

      React.useEffect(
        function () {
          if (target === null) return undefined
          function onKeyDown(event) {
            if (event.key === 'Escape') {
              event.stopPropagation()
              closeConfirm()
            }
          }
          window.addEventListener('keydown', onKeyDown, true)
          return function () {
            window.removeEventListener('keydown', onKeyDown, true)
          }
        },
        [target === null],
      )

      if (target === null) return null

      var title = String(target.displayTitle || target.sessionId)
      // 每次渲染都取一次：支持运行中切换明暗主题，且不缓存失效值。
      var p = palette()

      var card = h(
        'div',
        {
          style: cardStyle(p),
          role: 'dialog',
          'aria-modal': 'true',
          onMouseDown: function (event) {
            event.stopPropagation()
          },
        },
        h('div', { style: { fontSize: '14px', fontWeight: '600', marginBottom: '8px', color: p.label } }, '彻底删除会话'),
        h(
          'div',
          { style: { color: p.secondary } },
          '「' + title + '」的对话记录、冷读缓存、归档与置顶状态会被永久删除，无法恢复。',
        ),
        h(
          'div',
          { style: { marginTop: '6px', color: p.secondary, fontSize: '12px' } },
          '如果它正在运行，会先被停止。',
        ),
        error
          ? h(
              'div',
              { style: { marginTop: '10px', color: p.danger, fontSize: '12px', whiteSpace: 'pre-wrap' } },
              '删除失败：' + error,
            )
          : null,
        h(
          'div',
          { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle(p, 'ghost', busy),
              disabled: busy,
              onClick: closeConfirm,
            },
            '取消',
          ),
          h(
            'button',
            {
              type: 'button',
              style: buttonStyle(p, 'danger', busy),
              disabled: busy,
              onClick: function () {
                setError(null)
                runPurge(target, setBusy, setError)
              },
            },
            busy ? '删除中…' : '彻底删除',
          ),
        ),
      )

      return h(
        'div',
        {
          style: backdropStyle(p),
          onMouseDown: function (event) {
            if (event.target === event.currentTarget) closeConfirm()
          },
        },
        card,
      )
    }

    function TrashIcon() {
      var h = React.createElement
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: '14',
          height: '14',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M3 4.5h10' }),
        h('path', { d: 'M6.5 4.5V3.2h3v1.3' }),
        h('path', { d: 'M4.6 4.5l.6 8.1h5.6l.6-8.1' }),
        h('path', { d: 'M6.8 7v3.6M9.2 7v3.6' }),
      )
    }

    /* ---------------------------------------------------------------- 插件 */

    function apply(ctx) {
      pluginCtx = ctx

      // 右键菜单：排在归档（order 600）后面，危险色 + 分隔线。
      ctx.effect(
        function () {
          return ctx.contextMenus.register({
            id: MENU_ID,
            target: 'session',
            order: 700,
            resolve: function (target) {
              if (!target || typeof target.sessionId !== 'string') return []
              return [
                {
                  id: 'purge',
                  label: '彻底删除…',
                  danger: true,
                  separatorBefore: true,
                  icon: React === null ? undefined : { key: ICON_KEY },
                  run: function () {
                    openConfirm(target)
                  },
                },
              ]
            },
          })
        },
        'session-purge: session menu',
      )

      if (React === null) return

      // 菜单图标
      ctx.slots.inject('contextMenu.icon', function () {
        return ctx.slots.register({ name: 'contextMenu.icon', key: ICON_KEY }, TrashIcon)
      })

      // 确认浮层：app 级 layer，自己接管指针事件
      ctx.slots.inject('shell.overlay', function () {
        return ctx.slots.register({ name: 'shell.overlay', id: OVERLAY_ID, order: 900 }, PurgeConfirm)
      })
    }

    exports.inject = ['contextMenus', 'slots']
    exports.apply = apply
    // 仅仓库测试使用，不属于插件契约。
    exports.__test = { refreshSessionList: refreshSessionList, openConfirm: openConfirm, palette: palette }
    return module.exports
  },
})
