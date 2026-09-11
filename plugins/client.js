window.__ModuleLoader__.load({
  id: 'dsh-codex-mode',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const BASE = '/codex-agent-types/api/'
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

    const CSS = '.cam-root{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}.cam-root p{margin:0;white-space:pre-wrap}.cam-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.cam-card{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}.cam-field{display:flex;flex-direction:column;gap:4px}.cam-field input,.cam-field textarea,.cam-field select,.cam-actions button{font:inherit;color:inherit;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px}.cam-field textarea{resize:vertical}.cam-actions button{cursor:pointer}.cam-actions button:disabled{opacity:.5;cursor:default}.cam-message{padding:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px}'
    function apply(ctx) {
      const slots = ctx.get('slots')
      ctx.effect(() => {
        const tag = document.createElement('style')
        tag.dataset.pluginCss = 'dsh-codex-mode/settings'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      })
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section', id: 'codex-agent-types', order: 13, label: () => 'Codex 子代理',
      }, Settings))
    }
    return { inject: ['slots'], apply }
  },
})
