window.__ModuleLoader__.load({
  id: 'dsh-codex-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/codex-agent-types/api/'
    const CONTEXT_API = '/api/codex-context.state'
    const CONTEXT_TAB = 'codex-context'
    const CONTEXT_DIVIDER_KIND = 'codex-context-divider'
    const CONTEXT_NOTE_RESET_PREFIX = '[codex-context-note-reset:v1]'
    const CONTEXT_FALLBACK_PREFIX = '[codex-context-summary-fallback:v1]'
    const contextStateCache = new Map()
    const BUILTINS = new Set(['explorer', 'worker', 'reviewer'])

    async function request(path, body) {
      const response = await fetch(BASE + path, body === undefined ? {} : {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      const value = await response.json()
      if (!response.ok) {
        const error = new Error(typeof value.error === 'string' ? value.error : value.error?.message || `HTTP ${response.status}`)
        error.status = response.status
        throw error
      }
      return value
    }

    function validate(types) {
      const ids = new Set()
      for (const row of types) {
        if (!row.id.trim() || !row.name.trim()) return '类型 ID 和显示名不能为空。'
        if (!row.description.trim()) return `${row.id}：描述不能为空。`
        if (ids.has(row.id)) return `类型 ID 重复：${row.id}`
        ids.add(row.id)
        if (!!row.provider !== !!row.model) return `${row.id}：请选择完整的 provider 和 model，或同时留空以继承父会话。`
        if (row.reasoningEffort && (!row.provider || !row.model)) return `${row.id}：reasoning effort 需要显式 provider 和 model。`
      }
      return null
    }

    // Keep selections visible even when one provider's advisory catalog fails.
    function optionsWithCurrent(options, current) {
      return current && !options.some(option => option.id === current)
        ? [...options, { id: current, name: `${current}（目录暂不可用）` }]
        : options
    }

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function contextWindowKey(windowId) {
      return `${CONTEXT_DIVIDER_KIND.length}:${CONTEXT_DIVIDER_KIND}${windowId}`
    }

    function compactionMarker(event) {
      if (event?.type !== 'compaction/summary') return null
      const text = event.data?.summary?.[0]?.text
      if (typeof text !== 'string') return null
      if (text.startsWith(CONTEXT_NOTE_RESET_PREFIX)) return { kind: 'note-reset' }
      if (text.startsWith(CONTEXT_FALLBACK_PREFIX)) return { kind: 'fallback' }
      return null
    }

    function contextDividerDefinition() {
      return {
        kind: CONTEXT_DIVIDER_KIND,
        target: 'chat',
        match(event) {
          if (!compactionMarker(event)) return null
          const id = event.data?.compactionId ?? event.seq
          return { id: String(id), role: 'start' }
        },
        start(_context, match) {
          const event = match.event
          const marker = compactionMarker(event)
          return {
            windowId: typeof event.data?.windowId === 'string' ? event.data.windowId : '',
            markerId: String(event.data?.compactionId ?? event.seq),
            kind: marker?.kind || 'note-reset',
            seq: event.seq,
            time: event.time,
          }
        },
        update(context) { return context.state },
        buildViewNode(context) {
          if (!context.state) return null
          return {
            key: context.key,
            kind: CONTEXT_DIVIDER_KIND,
            id: context.id,
            target: 'chat',
            anchorSeq: context.state.seq,
            location: context.start?.location ?? { kind: 'unresolved' },
            visibility: 'visible',
            data: { ...context.state },
          }
        },
      }
    }

    async function readContextState(sessionId, signal, page = {}) {
      const response = await fetch(`${CONTEXT_API}?sessionId=${encodeURIComponent(sessionId)}${Object.keys(page).length ? `&${new URLSearchParams(page)}` : ''}`, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', signal,
      })
      let value
      try { value = await response.json() } catch { throw new Error('服务器返回了无效的上下文数据。') }
      if (response.status === 404 || (isRecord(value) && value.enabled === false)) {
        const error = new Error('此会话未启用 Codex 单窗口上下文。')
        error.code = 'codex-context-disabled'
        throw error
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      if (!isRecord(value) || value.enabled !== true) throw new Error('服务器返回了无效的上下文数据。')
      return value
    }

    async function probeContextEnabled(sessionId, signal) {
      const response = await fetch(`${CONTEXT_API}?sessionId=${encodeURIComponent(sessionId)}`, {
        method: 'HEAD', credentials: 'same-origin', cache: 'no-store', signal,
      })
      return response.status === 204
    }

    function formatTokens(value) {
      return Number.isFinite(value) && value >= 0 ? Math.round(value).toLocaleString() : '未知'
    }

    function formatTime(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      try { return new Date(value).toLocaleString() } catch { return '' }
    }

    function jumpToChat(sessionId, seq, windowId, sessions) {
      const binding = sessions.binding(sessionId)
      if (!binding) return Promise.resolve(false)
      return binding.session.loadThrough(seq).then(() => new Promise(resolve => {
        const anchor = contextWindowKey(windowId)
        let attempts = 0
        const findAndScroll = () => {
          const rows = typeof document === 'undefined' ? [] : document.querySelectorAll('[data-chat-anchor-key]')
          for (const row of rows) {
            if (row.dataset?.chatAnchorKey !== anchor || row.hidden) continue
            if (typeof row.scrollIntoView === 'function') row.scrollIntoView({ block: 'center', behavior: 'smooth' })
            resolve(true)
            return
          }
          if (++attempts >= 40) { resolve(false); return }
          if (typeof requestAnimationFrame === 'function') requestAnimationFrame(findAndScroll)
          else setTimeout(findAndScroll, 25)
        }
        findAndScroll()
      }))
    }

    function ContextOpener({ sessionId, useProjection, openContext }) {
      const preset = useProjection('agentPreset')
      const [probe, setProbe] = React.useState({ sessionId: null, status: 'checking', enabled: false })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        if (preset !== 'codex' || !sessionId) {
          setProbe({ sessionId, status: 'ready', enabled: false })
          return undefined
        }
        const controller = new AbortController()
        setProbe({ sessionId, status: 'checking', enabled: false })
        probeContextEnabled(sessionId, controller.signal).then(enabled => {
          if (!controller.signal.aborted) setProbe({ sessionId, status: 'ready', enabled })
        }, () => {
          if (!controller.signal.aborted) setProbe({ sessionId, status: 'error', enabled: false })
        })
        return () => controller.abort()
      }, [sessionId, preset])
      if (preset !== 'codex') return null
      if (probe.sessionId !== sessionId || probe.status !== 'ready' || probe.enabled !== true) return null
      async function open() {
        if (busy) return
        setBusy(true)
        setError('')
        try {
          const data = await readContextState(sessionId)
          contextStateCache.clear()
          contextStateCache.set(sessionId, data)
          openContext()
        } catch (failure) {
          if (failure.code === 'codex-context-disabled') setProbe({ sessionId, status: 'ready', enabled: false })
          setError(failure.message || '无法读取上下文状态。')
        } finally { setBusy(false) }
      }
      return h('div', { className: 'cctx-header-entry' },
        h('button', {
          type: 'button', className: 'cctx-opener', onClick: open, disabled: busy,
          'aria-label': '打开 Codex 上下文面板', title: 'Codex 上下文',
        }, busy ? '读取中…' : '上下文'),
        error && h('span', { role: 'status', className: 'cctx-header-error' }, error))
    }

    function ContextDivider({ node }) {
      const data = isRecord(node?.data) ? node.data : {}
      const fallback = data.kind === 'fallback'
      return h('details', {
        className: 'cctx-divider', 'data-codex-context-divider': data.windowId || node?.id || '',
      },
      h('summary', null, `新上下文窗口 · ${fallback ? '普通摘要兜底' : 'Note 重置'}`))
    }

    function ContextPanel({ sessionId, useProjection, useTabInfo, jumpToDivider }) {
      const contextVersion = useProjection('codexContextVersion')
      const [page, setPage] = React.useState({})
      const preset = useProjection('agentPreset')
      const { tab } = useTabInfo()
      const [result, setResult] = React.useState({ status: 'loading' })
      const [reloadKey, setReloadKey] = React.useState(0)
      const [jumping, setJumping] = React.useState(null)
      const [jumpError, setJumpError] = React.useState('')

      React.useEffect(() => {
        if (preset !== 'codex') {
          setResult({ status: 'unavailable' })
          return undefined
        }
        const cached = contextStateCache.get(sessionId)
        if (cached?.enabled === true) {
          contextStateCache.delete(sessionId)
          setResult({ status: 'ready', data: cached })
          return undefined
        }
        const controller = new AbortController()
        const abort = () => controller.abort()
        if (tab.signal.aborted) controller.abort()
        else tab.signal.addEventListener('abort', abort, { once: true })
        setResult({ status: 'loading' })
        readContextState(sessionId, controller.signal, page).then(data => {
          if (!controller.signal.aborted) setResult({ status: 'ready', data })
        }, error => {
          if (!controller.signal.aborted) setResult({ status: 'error', message: error.message || '上下文读取失败。' })
        })
        return () => {
          tab.signal.removeEventListener('abort', abort)
          controller.abort()
        }
      }, [sessionId, preset, tab.signal, reloadKey, contextVersion, page])

      const button = (label, onClick, disabled = false) => h('button', { type: 'button', onClick, disabled }, label)
      if (preset !== 'codex') return h('div', { className: 'cctx-root' }, h('p', { role: 'status' }, '仅 codex 会话可查看此面板。'))
      if (result.status === 'loading') return h('div', { className: 'cctx-root' }, h('h3', null, '上下文'), h('p', { role: 'status' }, '正在读取此会话的上下文信息…'))
      if (result.status === 'error' || result.status === 'unavailable') {
        return h('div', { className: 'cctx-root' }, h('h3', null, '上下文'),
          h('p', { role: 'alert' }, result.message || '此会话的上下文模式不可用。'),
          button('重试', () => setReloadKey(value => value + 1)))
      }

      const data = result.data
      const note = isRecord(data.note) ? data.note : null
      const budget = isRecord(data.budget) ? data.budget : {}
      const rawWindows = Array.isArray(data.windows) ? data.windows : []
      const windows = rawWindows.filter(row => isRecord(row) && typeof (row.id ?? row.windowId) === 'string')
        .slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0))
      const modelRemaining = budget.modelRemaining ?? budget.toolRemaining ?? budget.reportedRemaining
      const modelCapacity = budget.modelCapacity ?? budget.toolCapacity

      async function jump(row) {
        const seq = Number(row.dividerSeq ?? row.seq)
        if (!Number.isSafeInteger(seq) || seq < 0) return
        setJumping(row.id)
        setJumpError('')
        try {
          const found = await jumpToDivider(seq, row.id)
          if (!found) setJumpError('已加载历史，但未找到对应的聊天分隔标记。')
        } catch (error) {
          setJumpError(error.message || '无法跳转到聊天分隔标记。')
        } finally { setJumping(null) }
      }

      return h('div', { className: 'cctx-root' },
        h('div', { className: 'cctx-heading' }, h('h3', null, '上下文'), button('刷新', () => { setPage({}); setReloadKey(value => value + 1) })),
        h('section', { className: 'cctx-section', 'aria-labelledby': 'cctx-budget-title' },
          h('h4', { id: 'cctx-budget-title' }, '预算（估算）'),
          h('dl', null,
            h('dt', null, '本地使用估算'), h('dd', null, `${formatTokens(budget.estimatedUsed)} tokens`),
            h('dt', null, '预计剩余'), h('dd', null, `${formatTokens(budget.estimatedRemaining)} tokens`),
            h('dt', null, '窗口容量'), h('dd', null, `${formatTokens(budget.capacity)} tokens`))),
        h('section', { className: 'cctx-section', 'aria-labelledby': 'cctx-model-budget-title' },
          h('h4', { id: 'cctx-model-budget-title' }, '模型工具最近查询（同为估算）'),
          h('dl', null,
            h('dt', null, '模型剩余预算'), h('dd', null, modelRemaining == null ? '尚无最近一次工具查询' : `${formatTokens(modelRemaining)} tokens`),
            h('dt', null, '模型窗口容量'), h('dd', null, `${formatTokens(modelCapacity)} tokens`),
            h('dt', null, '报告时间'), h('dd', null, formatTime(budget.modelUpdatedAt ?? budget.toolUpdatedAt) || '未知'))),
        h('section', { className: 'cctx-section', 'aria-labelledby': 'cctx-note-title' },
          h('h4', { id: 'cctx-note-title' }, 'Note（只读）'),
          note ? h(React.Fragment, null,
            h('p', null, `版本：${note.revision ?? '未知'} · 所属窗口：${note.windowId ?? '未知'}`),
            h('p', null, `本窗口读取状态：${note.read === true ? '已读取' : '尚未读取'}`),
            h('pre', { className: 'cctx-note' }, typeof note.content === 'string' && note.content.length ? note.content : '当前没有可显示的 Note。'))
            : h('p', null, '当前没有可显示的 Note。'),
          note?.nextCursor && button('下一页 Note', () => setPage(value => ({ ...value, noteCursor: note.nextCursor }))),
          page.noteCursor && button('Note 首页', () => setPage(value => ({ ...value, noteCursor: '' }))),
          h('p', { className: 'cctx-footnote' }, '摘要兜底会清除活跃 Note；已写入的历史日志/导出副本不会因此被擦除。')),
        h('section', { className: 'cctx-section', 'aria-labelledby': 'cctx-timeline-title' },
          h('h4', { id: 'cctx-timeline-title' }, '窗口时间线'),
          windows.length ? h('ol', { className: 'cctx-timeline' }, windows.map(row => {
            const fallback = row.kind === 'fallback' || String(row.kind || '').includes('fallback')
            const seq = Number(row.dividerSeq)
            const canJump = Number.isSafeInteger(seq) && seq >= 0 && typeof row.dividerId === 'string' && row.dividerId.length > 0
            const markerId = row.dividerId
            const windowId = String(row.windowId ?? row.id ?? '')
            const label = `${formatTime(row.time) || '时间未知'} · ${fallback ? '普通摘要兜底' : row.kind === 'initial' ? '首次窗口' : 'Note 重置'}${windowId === data.windowId || row.id === data.windowId ? '（当前）' : ''}`
            return h('li', { key: row.id }, canJump
              ? button(label, () => jump({ ...row, id: markerId }), jumping !== null)
              : h('span', null, label),
            canJump && h('small', null, `日志位置 ${seq}`))
          })) : h('p', null, data.windowId ? `当前窗口：${data.windowId}；尚无已记录的切窗节点。` : '暂无窗口记录。'),
          data.nextOffset != null && button('下一页窗口', () => setPage(value => ({ ...value, windowOffset: data.nextOffset }))),
          page.windowOffset > 0 && button('窗口首页', () => setPage(value => ({ ...value, windowOffset: 0 }))),
          jumpError && h('p', { role: 'status' }, jumpError),
          jumping && h('p', { role: 'status' }, '正在加载并定位聊天分隔标记…'))
      )
    }

    function Settings() {
      const [state, setState] = React.useState(null)
      const [types, setTypes] = React.useState([])
      const [catalog, setCatalog] = React.useState({ providers: [], models: [] })
      const [presets, setPresets] = React.useState([])
      const [presetMessage, setPresetMessage] = React.useState('')
      const [message, setMessage] = React.useState('')
      const [catalogMessage, setCatalogMessage] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [dirty, setDirty] = React.useState(false)
      const [armed, setArmed] = React.useState(null)
      const alive = React.useRef(true)

      async function loadPresets() {
        try {
          const value = await request('presets')
          if (!alive.current) return
          setPresets(value.presets || [])
          setPresetMessage('')
        } catch (error) {
          if (alive.current) setPresetMessage(`Preset 目录加载失败（保留当前配置及已有目录）：${error.message}`)
        }
      }

      async function loadModels() {
        try {
          const value = await request('models')
          if (!alive.current) return
          setCatalog({ providers: value.providers || [], models: value.models || [] })
          setCatalogMessage(value.failures?.length || value.errors?.length ? '部分 provider / model 目录加载失败；已选模型仍保留，可重试刷新模型目录。' : '')
        } catch (error) {
          if (alive.current) setCatalogMessage(`模型目录加载失败（保留已有目录）：${error.message}`)
        }
      }

      async function loadState() {
        setBusy(true)
        try {
          const value = await request('state')
          if (!alive.current) return
          setState(value)
          setTypes(value.types.map(row => ({ ...row })))
          setDirty(false)
          setArmed(null)
          setMessage('')
        } catch (error) {
          if (alive.current) setMessage(`加载失败：${error.message}`)
        } finally { if (alive.current) setBusy(false) }
      }

      React.useEffect(() => {
        alive.current = true
        loadState()
        loadModels()
        loadPresets()
        return () => { alive.current = false }
      }, [])

      function edit(index, patch) {
        setTypes(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row))
        setDirty(true)
        setArmed(null)
      }

      async function save() {
        const problem = validate(types)
        if (problem) { setMessage(problem); return }
        setBusy(true)
        try {
          const normalized = types.map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) =>
            !['provider', 'model', 'reasoningEffort', 'preset'].includes(key) || !!value)))
          const value = await request('state', { revision: state.revision, types: normalized })
          if (!alive.current) return
          setState(value)
          setTypes(value.types.map(row => ({ ...row })))
          setDirty(false)
          setArmed(null)
          setMessage('已保存。当前运行请求不会被打断；下次模型请求会注入新类型。工具名称固定，调用时必须填写 agent_type。')
        } catch (error) {
          if (alive.current) setMessage(error.status === 409
            ? '保存冲突：配置已被其他窗口更新。本地编辑已保留；请复制需保留的内容，再点击「重新加载」读取最新版本后重试。'
            : `保存失败（本地编辑已保留）：${error.message}`)
        } finally { if (alive.current) setBusy(false) }
      }

      const button = (text, onClick, disabled = busy) => h('button', { type: 'button', onClick, disabled }, text)
      const field = (label, input) => h('label', { className: 'cam-field' }, h('span', null, label), input)
      function select(value, options, emptyLabel, onChange, disabled = false) {
        return h('select', { value: value || '', disabled: busy || disabled, onChange: event => onChange(event.target.value) },
          h('option', { value: '' }, emptyLabel),
          optionsWithCurrent(options, value).map(option => h('option', { key: option.id, value: option.id, disabled: option.broken !== undefined, title: option.broken ?? option.description }, (option.name || option.id) + (option.broken !== undefined ? '（破损，不可选）' : ''))))
      }
      return h('div', { className: 'cam-root' },
        h('h3', null, 'Codex 子代理'),
        h('p', null, '管理 explorer、worker、reviewer 和自定义类型。类型只决定子代理的模型路由与 Preset 组合，不携带自己的指令：每次调用的启动 prompt 由父代理在 prompt 参数中完整给出，描述字段仅用于父代理挑选类型。'),
        h('p', null, '留空模型配置时继承父会话；这里只配置子代理，不改变当前会话或全局默认模型。每种类型可独立选择 DSH Preset，留空继承父代理 Preset。目录新增后可点击刷新。'),
        h('div', { className: 'cam-actions' },
          button('保存' + (dirty ? ' *' : ''), save, busy || !state || !dirty),
          button(armed === 'reload' ? '确认放弃编辑并重新加载' : '重新加载', () => {
            if (dirty && armed !== 'reload') { setArmed('reload'); return }
            loadState()
          }),
          button('刷新模型目录', loadModels),
          button('刷新 Preset 目录', loadPresets),
          button('新增类型', () => {
            let id = 'custom'; let n = 1
            while (types.some(row => row.id === id)) id = `custom-${n++}`
            setTypes(rows => [...rows, { id, name: '自定义子代理', description: '' }])
            setDirty(true)
          }, busy || !state)),
        message && h('p', { role: 'status', className: 'cam-message' }, message),
        catalogMessage && h('p', { role: 'status', className: 'cam-message' }, catalogMessage),
        presetMessage && h('p', { role: 'status', className: 'cam-message' }, presetMessage),
        !state && h('p', null, busy ? '正在加载…' : '配置尚未加载，请重试。'),
        types.map((row, index) => {
          const models = catalog.models.filter(model => model.provider === row.provider)
          const currentModel = models.find(model => model.id === row.model)
          const efforts = currentModel?.reasoning?.efforts || []
          const builtin = BUILTINS.has(row.id)
          const text = (key, multiline = false) => h(multiline ? 'textarea' : 'input', {
            value: row[key] || '', disabled: busy || (key === 'id' && builtin),
            rows: multiline ? 3 : undefined,
            onChange: event => edit(index, { [key]: event.target.value }),
          })
          return h('section', { className: 'cam-card', key: index },
            h('div', { className: 'cam-actions' }, h('strong', null, row.name || row.id),
              builtin ? h('span', null, '内建类型') : button(armed === index ? '确认删除' : '删除', () => {
                if (armed !== index) { setArmed(index); return }
                setTypes(rows => rows.filter((_, i) => i !== index)); setDirty(true); setArmed(null)
              })),
            field('类型 ID', text('id')), field('显示名', text('name')),
            field('描述（供主代理选择类型）', text('description', true)),
            field('Preset', select(row.preset, presets, '继承父代理 Preset', preset => edit(index, { preset }))),
            field('Provider', select(row.provider, catalog.providers, '继承父会话', provider => edit(index, { provider, model: '', reasoningEffort: '' }))),
            field('Model', select(row.model, models, row.provider ? '请选择模型' : '继承父会话', model => edit(index, { model, reasoningEffort: '' }), !row.provider)),
            field('Reasoning effort', select(row.reasoningEffort, efforts,
              `自动（同模型继承父设置，切换模型用默认${currentModel?.reasoning?.defaultEffort ? ` ${currentModel.reasoning.defaultEffort}` : ''}）`,
              reasoningEffort => edit(index, { reasoningEffort }), !row.provider || !row.model)),
          )
        }),
        h('p', null, '保存不会中断当前运行请求；下次模型请求注入新类型。工具名称固定，agent_type 为必填参数，子代理的启动指令完全来自该次调用的 prompt。'))
    }

    const CSS = '.cam-root{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}.cam-root p{margin:0;white-space:pre-wrap}.cam-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cam-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.cam-field{display:flex;flex-direction:column;gap:4px}.cam-field input,.cam-field textarea,.cam-field select,.cam-actions button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px}.cam-field textarea{resize:vertical}.cam-actions button{cursor:pointer}.cam-actions button:disabled{opacity:.5;cursor:default}.cam-message{padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px}' +
      '.cctx-root{box-sizing:border-box;width:100%;height:100%;overflow:auto;display:flex;flex-direction:column;gap:12px;padding:14px;color:var(--dsw-alias-label-primary);font-size:13px}.cctx-root h3,.cctx-root h4,.cctx-root p{margin:0}.cctx-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.cctx-section{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0}.cctx-section h4{font-size:13px}.cctx-section dl{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin:0}.cctx-section dt{color:var(--dsw-alias-label-secondary)}.cctx-section dd{margin:0;text-align:right;overflow-wrap:anywhere}.cctx-note{box-sizing:border-box;max-height:38vh;overflow:auto;margin:0;padding:10px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--dsw-alias-bg-layer-1);border-radius:6px;font:inherit}.cctx-footnote,.cctx-timeline small{color:var(--dsw-alias-label-tertiary);font-size:12px}.cctx-timeline{display:flex;flex-direction:column;gap:8px;margin:0;padding-left:22px}.cctx-timeline li{padding-left:2px}.cctx-timeline button,.cctx-root button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;cursor:pointer}.cctx-timeline button{max-width:100%;text-align:left;overflow-wrap:anywhere}.cctx-root button:disabled{opacity:.5;cursor:default}.cctx-timeline small{display:block;margin-top:3px}.cctx-header-entry{display:inline-flex;align-items:center;gap:6px}.cctx-header-error{max-width:220px;color:var(--dsw-alias-label-tertiary);font-size:11px}.cctx-opener{font:inherit;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:5px 8px;cursor:pointer}.cctx-opener:hover{background:var(--dsw-alias-interactive-bg-hover)}.cctx-divider{max-width:var(--dsh-chat-content-width,748px);margin:8px auto;padding:8px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.cctx-divider summary{cursor:pointer;font-weight:600}.cctx-divider p{margin:6px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}'
    function apply(ctx) {
      const slots = ctx.get('slots')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.pluginCss = 'dsh-codex-mode/settings'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      })
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: 'dsh-codex-mode/context', kind: CONTEXT_TAB, title: () => '上下文',
      }), 'dsh-codex-mode: context sidebar tab type')
      ctx.effect(() => ctx.uiConversation.events.register(contextDividerDefinition()), 'dsh-codex-mode: context window Chat markers')
      ctx.effect(() => slots.inject('settings.section', () => slots.register({
        name: 'settings.section', id: 'codex-agent-types', order: 13, label: () => 'Codex 子代理',
      }, Settings)), 'dsh-codex-mode: agent type settings section')
      ctx.effect(() => slots.inject('conversation.session.header.actions', () => slots.register({
        name: 'conversation.session.header.actions', id: 'codex-context-opener', order: 14,
        inject: () => ({ openContext: () => ctx.sidebarRight.openTab(CONTEXT_TAB) }),
      }, ContextOpener)), 'dsh-codex-mode: context session header opener')
      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab', key: CONTEXT_TAB,
        inject: sessionId => ({
          jumpToDivider: (seq, windowId) => jumpToChat(sessionId, seq, windowId, ctx.sessions),
          hooks: { tabInfo: (_standard, useTabInfo) => useTabInfo },
        }),
      }, ContextPanel)), 'dsh-codex-mode: context sidebar body')
      ctx.effect(() => slots.inject('conversation.chat.node', () => slots.register({
        name: 'conversation.chat.node', key: CONTEXT_DIVIDER_KIND,
      }, ContextDivider)), 'dsh-codex-mode: context Chat divider renderer')
    }
    return { inject: ['slots', 'sidebarRightTabs', 'sidebarRight', 'sessions', 'uiConversation'], apply }
  },
})
