window.__ModuleLoader__.load({
  id: 'dsh-image-guard-toggle',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')

    const NAMESPACE = 'image-guard-toggle'
    const MIN_MB = 1
    const MAX_MB = 64

    const capsule = {
      border: '1px solid var(--dsw-alias-border-l2)',
      height: '32px',
      color: 'var(--dsw-alias-label-primary)',
      fontFamily: 'var(--dsw-font-family)',
      background: 'transparent',
      borderRadius: '18px',
      alignItems: 'center',
      gap: '6px',
      padding: '6px 12px',
      fontSize: '13px',
      fontWeight: '400',
      lineHeight: '20px',
      display: 'inline-flex',
      whiteSpace: 'nowrap',
    }

    const togglePart = {
      cursor: 'pointer',
      color: 'inherit',
      fontFamily: 'inherit',
      background: 'transparent',
      border: 'none',
      borderRadius: '10px',
      alignItems: 'center',
      gap: '6px',
      padding: '0 2px',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      display: 'inline-flex',
      whiteSpace: 'nowrap',
    }

    const budgetInput = {
      cursor: 'pointer',
      color: 'var(--dsw-alias-label-secondary)',
      fontFamily: 'inherit',
      background: 'transparent',
      border: 'none',
      borderBottom: '1px dashed var(--dsw-alias-border-l2)',
      borderRadius: '4px',
      outline: 'none',
      boxSizing: 'border-box',
      width: '28px',
      minWidth: '28px',
      flex: 'none',
      height: '21px',
      padding: '0 1px',
      fontSize: '13px',
      fontWeight: '400',
      lineHeight: '20px',
      textAlign: 'center',
      appearance: 'none',
      WebkitAppearance: 'none',
    }

    const budgetInputEditing = Object.assign({}, budgetInput, {
      cursor: 'text',
      color: 'var(--dsw-alias-label-primary)',
      borderBottom: '1px solid var(--dsw-alias-border-l2)',
    })

    function parseBudget(raw) {
      if (!/^\d+$/.test(raw)) return undefined
      const n = Number(raw)
      if (!Number.isInteger(n) || n < MIN_MB || n > MAX_MB) return undefined
      return n
    }

    function GuardToggle({ scope }) {
      const [snap, setSnap] = React.useState(scope.getSnapshot())
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState('')
      const [draft, setDraft] = React.useState(undefined)

      React.useEffect(() => scope.subscribe(() => {
        setSnap(scope.getSnapshot())
        setPending(false)
      }), [])

      const loading = snap.status === 'loading'
      const stored = snap.value && typeof snap.value === 'object' ? snap.value : null
      const enabled = stored === null ? true : stored.enabled !== false
      const budget = stored && Number.isFinite(Number(stored.budgetMb)) && Number(stored.budgetMb) > 0
        ? Number(stored.budgetMb)
        : 8
      const route = stored && typeof stored.route === 'string' && stored.route.length > 0 ? stored.route : 'hyper'
      const writable = snap.writable === true

      const toggle = async () => {
        if (!writable || pending) return
        setPending(true)
        setError('')
        try {
          await scope.set('enabled', !enabled)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setPending(false)
          setSnap(scope.getSnapshot())
        }
      }

      const commitBudget = async () => {
        const raw = draft
        setDraft(undefined)
        if (raw === undefined || !writable || pending) return
        const next = parseBudget(raw)
        if (next === undefined) {
          setError(`Budget must be a whole number between ${MIN_MB} and ${MAX_MB} MB`)
          return
        }
        setError('')
        if (next === budget) return
        setPending(true)
        try {
          await scope.set('budgetMb', next)
        } catch (err) {
          setError(String((err && err.message) || err))
        } finally {
          setPending(false)
          setSnap(scope.getSnapshot())
        }
      }

      const dot = enabled
        ? 'var(--dsw-alias-state-success-primary, #2ecc71)'
        : 'var(--dsw-alias-label-dimmed, #888)'

      const title = error !== ''
        ? error
        : (writable
          ? `Toggle the request image-size guard: on bounds llm-pi-ai route "${route}" images to ${budget} MB, off restores the adapter default (20 MB). Takes effect on the next request. Click the number to type a new budget (${MIN_MB}-${MAX_MB} MB).`
          : 'This browser cannot write settings.')

      return React.createElement('span', { style: capsule, title },
        React.createElement('button', {
          type: 'button',
          style: Object.assign({}, togglePart, { opacity: loading || !writable ? 0.6 : 1 }),
          disabled: loading || pending,
          'aria-pressed': enabled,
          onClick: () => void toggle(),
        },
          React.createElement('span', {
            style: { width: '8px', height: '8px', borderRadius: '50%', background: dot, flex: 'none' },
          }),
          React.createElement('span', null, 'image guard'),
        ),
        React.createElement('input', {
          type: 'text',
          inputMode: 'numeric',
          size: 2,
          value: draft === undefined ? String(budget) : draft,
          readOnly: !writable,
          disabled: loading || !writable,
          'aria-label': 'image guard budget in MB',
          style: draft === undefined ? budgetInput : budgetInputEditing,
          onChange: (event) => setDraft(event.target.value),
          onFocus: (event) => {
            setDraft(String(budget))
            event.target.select()
          },
          onBlur: () => void commitBudget(),
          onKeyDown: (event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.target.blur()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setDraft(undefined)
              setError('')
              event.target.blur()
            }
          },
        }),
        React.createElement('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, 'MB'),
        enabled ? null : React.createElement('span', { style: { color: 'var(--dsw-alias-label-dimmed, #888)' } }, 'off'),
      )
    }

    function apply(ctx) {
      const slots = ctx.get('slots')
      const settingsScope = ctx.get('settingsScope')
      if (!React || slots === undefined || settingsScope === undefined) return

      const scope = settingsScope.bind({ namespace: NAMESPACE })

      slots.inject('conversation.session.header.utilities', () => slots.register({
        name: 'conversation.session.header.utilities',
        id: 'dsh-image-guard-toggle',
        order: -2,
        label: 'image guard toggle',
      }, () => React.createElement(GuardToggle, { scope })))
    }

    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    return module.exports
  },
})
