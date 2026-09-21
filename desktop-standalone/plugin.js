/**
 * Codex Limits — a chip before the composer's model pill showing how much of
 * the Codex (ChatGPT plan) quota is left; click for every window and every
 * pooled account. Data comes from this plugin's own backend route
 * (`/api/plugins/codex-limits/usage`, served by the agent package at
 * `~/.hermes/plugins/codex-limits/dashboard/plugin_api.py`), which reuses the
 * fetch behind `hermes usage --json`. This half lives in the standalone
 * `desktop-plugins/` root so it is on by default (a package's `desktop/` half
 * is opt-in).
 *
 * Plain ESM with `jsx()` calls — loaded at runtime, so only Tailwind classes
 * core already ships are used; everything custom is an inline style.
 */

import { Button, cn, host, icons, Popover, PopoverContent, PopoverTrigger, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const STALE_MS = 60_000
const POLL_MS = 5 * 60_000
const AFTER_TURN_DELAY_MS = 4_000
const LOW_REMAINING = 25
const CRITICAL_REMAINING = 10

const WINDOW_LABELS = { Session: '5 часов', Weekly: 'Неделя' }

// ---------------------------------------------------------------------------
// One shared store for every mounted chip (split tiles mount several
// composers): a single in-flight fetch and a single poll timer.
// ---------------------------------------------------------------------------

let rest = null
let snapshot = { status: 'idle', data: null, error: null, at: 0 }
let inflight = null
// The plugin route only exists on a backend that has the agent package
// installed. A remote backend without it answers 404 — remember that and read
// the core `session.usage` RPC instead (retried on a manual refresh).
let restMissing = false
let sessionId = null

const NO_SESSION = 'no-session'
let mounted = 0
let pollTimer = null
const listeners = new Set()

function publish(next) {
  snapshot = { ...snapshot, ...next }
  listeners.forEach(listener => listener())
}

function subscribe(listener) {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

// `session.usage` renders the account block as text (the `/usage` lines):
//   Provider: openai-codex (Prolite)
//   Weekly: 5% remaining (95% used) • resets in 4d 22h (2026-09-26 12:57 UTC)
//   Extra: unavailable • n/a
//   Credits balance: $4.20
const PROVIDER_LINE = /^Provider:\s*(\S+)(?:\s*\((.+)\))?\s*$/
const WINDOW_LINE = /^(.+?):\s*\d+% remaining \((\d+)% used\)(?:\s*•\s*(.*))?$/
const UNAVAILABLE_WINDOW_LINE = /^(.+?):\s*unavailable(?:\s*•\s*(.*))?$/
const UNAVAILABLE_LINE = /^Unavailable:\s*(.*)$/
const RESET_UTC_STAMP = /\((\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (?:UTC|GMT)\)/
const RESET_RELATIVE = /resets in (?:(\d+)d)?\s*(?:(\d+)h)?\s*(?:(\d+)m)?/

/** Reset moment from a window line's tail. The stamp is in the SERVER's zone,
 *  so only a UTC one is trusted; otherwise rebuild it from the relative part. */
function parseReset(tail) {
  const stamp = RESET_UTC_STAMP.exec(tail)

  if (stamp) {
    return `${stamp[1]}T${stamp[2]}:00Z`
  }

  if (/resets now\b/.test(tail)) {
    return new Date().toISOString()
  }

  const [, days, hours, minutes] = RESET_RELATIVE.exec(tail) ?? []

  if (!days && !hours && !minutes) {
    return null
  }

  const totalMinutes = (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 60 + Number(minutes ?? 0)

  return new Date(Date.now() + totalMinutes * 60_000).toISOString()
}

function parseAccountLines(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    return null
  }

  const account = { index: 1, available: true, details: [], plan: null, provider: null, windows: [] }

  for (const raw of lines) {
    const line = String(raw).replaceAll('**', '').trim()
    let match

    if (!line || line.startsWith('📈')) {
      continue
    }

    if ((match = PROVIDER_LINE.exec(line))) {
      account.provider = match[1]
      account.plan = match[2] ?? null
    } else if ((match = UNAVAILABLE_LINE.exec(line))) {
      account.unavailable_reason = match[1]
    } else if ((match = WINDOW_LINE.exec(line))) {
      const tail = match[3] ?? ''
      const resetsAt = parseReset(tail)

      account.windows.push({
        label: match[1],
        used_percent: Number(match[2]),
        resets_at: resetsAt,
        detail: resetsAt ? null : tail || null
      })
    } else if ((match = UNAVAILABLE_WINDOW_LINE.exec(line))) {
      account.windows.push({ label: match[1], used_percent: null, resets_at: null, detail: match[2] ?? null })
    } else {
      account.details.push(line)
    }
  }

  account.available = account.windows.length > 0 || account.details.length > 0

  return account
}

async function fetchViaGateway() {
  if (!sessionId) {
    throw new Error(NO_SESSION)
  }

  const usage = await host.request('session.usage', { session_id: sessionId }, 45_000)
  const account = parseAccountLines(usage?.account_lines)

  if (!account) {
    // `account_lines` shipped in hermes-agent 604d8803a1 (2026-09-19); an older
    // backend answers without it. It is also omitted when the backend's own
    // usage fetch fails (fail-open), so word this as the likely cause only.
    throw new Error(
      'сервер Hermes не прислал лимиты. Скорее всего, он старее 19.09.2026 — обновите Hermes на сервере (hermes update)'
    )
  }

  return { provider: account.provider, fetched_at: Date.now() / 1000, accounts: [account], source: 'gateway' }
}

async function fetchLimits(force) {
  if (restMissing && !force) {
    return fetchViaGateway()
  }

  try {
    const data = await rest(`/usage${force ? '?force=true' : ''}`, { timeoutMs: 45_000 })

    restMissing = false

    return data
  } catch (error) {
    if (!/\b404\b/.test(String(error?.message || error))) {
      throw error
    }

    restMissing = true

    return fetchViaGateway()
  }
}

function refresh(force = false) {
  if (!rest) {
    return Promise.resolve()
  }

  if (inflight) {
    return inflight
  }

  publish({ status: snapshot.data ? 'refreshing' : 'loading' })
  inflight = fetchLimits(force)
    .then(data => publish({ status: 'ready', data, error: null, at: Date.now() }))
    .catch(error => {
      if (error?.message === NO_SESSION) {
        return publish({ status: NO_SESSION, error: null, at: 0 })
      }

      const message = String(error?.message || error)

      // Lands in ~/.hermes/logs/desktop.log — the only trace a chip failure
      // leaves. Once per distinct failure: the poll would otherwise repeat it.
      if (snapshot.error !== message) {
        console.error('[codex-limits] usage fetch failed:', message)
      }

      return publish({ status: 'error', error: message, at: Date.now() })
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}

function refreshIfStale() {
  if (Date.now() - snapshot.at > STALE_MS) {
    void refresh()
  }
}

function useLimits() {
  const state = useSyncExternalStore(subscribe, () => snapshot)

  useEffect(() => {
    mounted += 1
    refreshIfStale()
    pollTimer ??= setInterval(() => void refresh(), POLL_MS)

    return () => {
      mounted -= 1

      if (mounted === 0 && pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  }, [])

  return state
}

/** The gateway fallback reads a session's route, so it needs a live session id:
 *  follow the focused chat and fetch as soon as there is one. */
function useSessionBinding() {
  const focused = useValue(host.state.focusedSessionId)
  const active = useValue(host.state.activeSessionId)
  const current = focused ?? active ?? null

  useEffect(() => {
    sessionId = current

    if (!current || !restMissing) {
      return
    }

    if (snapshot.status === NO_SESSION || !snapshot.data) {
      void refresh()
    } else {
      refreshIfStale()
    }
  }, [current])
}

/** Quota moves when a turn ends — re-read shortly after the focused chat goes idle. */
function useRefreshAfterTurn() {
  const busy = useValue(host.state.busy)
  const wasBusy = useRef(busy)

  useEffect(() => {
    const finished = wasBusy.current && !busy
    wasBusy.current = busy

    if (!finished) {
      return undefined
    }

    const timer = setTimeout(() => void refresh(true), AFTER_TURN_DELAY_MS)

    return () => clearTimeout(timer)
  }, [busy])
}

// ---------------------------------------------------------------------------
// Derivations + formatting
// ---------------------------------------------------------------------------

const remainingOf = window =>
  typeof window?.used_percent === 'number' ? Math.max(0, Math.min(100, Math.round(100 - window.used_percent))) : null

/** Tightest window of an account — the number that actually gates the next turn. */
function tightest(account) {
  const values = (account?.windows ?? []).map(remainingOf).filter(value => value !== null)

  return values.length ? Math.min(...values) : null
}

/** The account Hermes is drawing from: first pool entry that is not exhausted. */
function activeAccount(accounts) {
  const usable = accounts.filter(account => account.available && tightest(account) !== null)

  return usable.find(account => account.pool_status !== 'exhausted') ?? usable[0] ?? null
}

function toneColor(remaining) {
  if (remaining === null) {
    return 'var(--ui-text-quaternary)'
  }

  if (remaining <= CRITICAL_REMAINING) {
    return 'var(--ui-red, #e5484d)'
  }

  if (remaining <= LOW_REMAINING) {
    return 'var(--ui-yellow, #e2a336)'
  }

  return 'var(--ui-green, #46a758)'
}

function formatCountdown(iso) {
  const ms = new Date(iso).getTime() - Date.now()

  if (!Number.isFinite(ms)) {
    return ''
  }

  if (ms <= 0) {
    return 'сброс вот-вот'
  }

  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const parts = days ? [`${days} д`, `${hours} ч`] : hours ? [`${hours} ч`, `${minutes % 60} мин`] : [`${minutes} мин`]

  return `сброс через ${parts.join(' ')}`
}

const formatMoment = iso =>
  new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const formatClock = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

/** Depleting ring: the arc IS the remaining share. */
function Ring({ remaining, size = 14 }) {
  const stroke = 2
  const radius = (size - stroke) / 2
  const circumference = 2 * Math.PI * radius
  const share = remaining === null ? 0 : remaining / 100

  return jsxs('svg', {
    'aria-hidden': true,
    height: size,
    style: { flexShrink: 0, transform: 'rotate(-90deg)' },
    viewBox: `0 0 ${size} ${size}`,
    width: size,
    children: [
      jsx('circle', {
        cx: size / 2,
        cy: size / 2,
        fill: 'none',
        r: radius,
        stroke: 'currentColor',
        strokeOpacity: 0.22,
        strokeWidth: stroke
      }),
      jsx('circle', {
        cx: size / 2,
        cy: size / 2,
        fill: 'none',
        r: radius,
        stroke: toneColor(remaining),
        strokeDasharray: `${circumference * share} ${circumference}`,
        strokeLinecap: 'round',
        strokeWidth: stroke
      })
    ]
  })
}

function WindowRow({ window }) {
  const remaining = remainingOf(window)
  const label = WINDOW_LABELS[window.label] ?? window.label

  return jsxs('div', {
    style: { display: 'grid', gap: 4 },
    children: [
      jsxs('div', {
        style: { alignItems: 'baseline', display: 'flex', justifyContent: 'space-between', gap: 12 },
        children: [
          jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: label }),
          jsx('span', {
            style: { color: toneColor(remaining), fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
            children: remaining === null ? 'нет данных' : `осталось ${remaining}%`
          })
        ]
      }),
      jsx('div', {
        style: { background: 'var(--chrome-action-hover)', borderRadius: 999, height: 4, overflow: 'hidden' },
        children: jsx('div', {
          style: {
            background: toneColor(remaining),
            borderRadius: 999,
            height: '100%',
            transition: 'width 300ms ease',
            width: `${remaining ?? 0}%`
          }
        })
      }),
      window.resets_at
        ? jsx('div', {
            style: { color: 'var(--ui-text-tertiary)', fontSize: '0.6875rem' },
            children: `${formatCountdown(window.resets_at)} · ${formatMoment(window.resets_at)}`
          })
        : window.detail
          ? jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.6875rem' }, children: window.detail })
          : null
    ]
  })
}

function AccountBlock({ account, showIdentity }) {
  const exhausted = account.pool_status === 'exhausted'

  return jsxs('div', {
    style: { display: 'grid', gap: 8 },
    children: [
      showIdentity
        ? jsxs('div', {
            style: { alignItems: 'baseline', display: 'flex', justifyContent: 'space-between', gap: 12 },
            children: [
              jsx('span', {
                style: { fontWeight: 600 },
                children: `#${account.index} ${account.label || account.id || 'аккаунт'}`
              }),
              jsx('span', {
                style: { color: exhausted ? 'var(--ui-red, #e5484d)' : 'var(--ui-text-tertiary)', fontSize: '0.6875rem' },
                children: [account.plan, exhausted ? 'исчерпан' : null].filter(Boolean).join(' · ')
              })
            ]
          })
        : null,
      account.available
        ? account.windows.map(window => jsx(WindowRow, { window }, window.label))
        : jsx('div', {
            style: { color: 'var(--ui-text-tertiary)' },
            children: account.unavailable_reason || 'Лимиты недоступны'
          }),
      ...(account.details ?? []).map(line =>
        jsx('div', { style: { color: 'var(--ui-text-tertiary)', fontSize: '0.6875rem' }, children: line }, line)
      )
    ]
  })
}

function LimitsPanel({ state }) {
  const accounts = state.data?.accounts ?? []
  const pooled = accounts.length > 1
  const plan = !pooled ? accounts[0]?.plan : null
  const working = state.status === 'loading' || state.status === 'refreshing'
  const provider = state.data?.provider
  const title = !provider || provider === 'openai-codex' ? 'Лимиты Codex' : `Лимиты · ${provider}`

  return jsxs('div', {
    style: { display: 'grid', fontSize: '0.75rem', gap: 12, minWidth: 248 },
    children: [
      jsxs('div', {
        style: { alignItems: 'baseline', display: 'flex', justifyContent: 'space-between', gap: 12 },
        children: [
          jsx('span', { style: { fontWeight: 600 }, children: pooled ? `${title} · пул (${accounts.length})` : title }),
          plan ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: plan }) : null
        ]
      }),
      state.status === 'error' && !accounts.length
        ? jsx('div', { style: { color: 'var(--ui-red, #e5484d)' }, children: `Не удалось получить лимиты: ${state.error}` })
        : null,
      state.status === NO_SESSION && !accounts.length
        ? jsx('div', {
            style: { color: 'var(--ui-text-tertiary)' },
            children: 'Откройте любой чат — лимиты берутся из его сессии.'
          })
        : null,
      !accounts.length && (state.status === 'idle' || working)
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Загружаю…' })
        : null,
      ...accounts.map(account => jsx(AccountBlock, { account, showIdentity: pooled }, account.id ?? account.index)),
      state.data?.source === 'gateway'
        ? jsx('div', {
            style: { color: 'var(--ui-text-quaternary)', fontSize: '0.6875rem' },
            children: 'Аккаунт, на котором работает этот чат (данные сервера).'
          })
        : null,
      jsxs('div', {
        style: {
          alignItems: 'center',
          borderTop: '1px solid var(--chrome-action-hover)',
          color: 'var(--ui-text-quaternary)',
          display: 'flex',
          fontSize: '0.6875rem',
          justifyContent: 'space-between',
          paddingTop: 8
        },
        children: [
          jsx('span', { children: state.at ? `обновлено в ${formatClock(state.at)}` : '' }),
          jsxs(Button, {
            className: 'h-6 gap-1 px-1.5 text-xs font-normal',
            disabled: working,
            onClick: () => void refresh(true),
            type: 'button',
            variant: 'ghost',
            children: [jsx(icons.RefreshCw, { className: 'size-3' }), working ? 'Обновляю…' : 'Обновить']
          })
        ]
      })
    ]
  })
}

function LimitsChip() {
  useSessionBinding()

  const state = useLimits()
  const [open, setOpen] = useState(false)

  useRefreshAfterTurn()

  const accounts = state.data?.accounts ?? []
  const account = activeAccount(accounts)
  const remaining = tightest(account)

  // Nothing to show for this setup (no Codex credential) — stay out of the row.
  if (state.status === 'ready' && !account) {
    return null
  }

  const settled = state.status === 'error' || state.status === NO_SESSION
  const label = remaining === null ? (settled ? '—' : '…') : `${remaining}%`
  const provider = state.data?.provider
  const subject = !provider || provider === 'openai-codex' ? 'Codex' : provider

  const problem =
    state.status === 'error' ? state.error : state.status === NO_SESSION ? 'откройте чат, чтобы подтянуть данные' : null

  const tip =
    remaining === null
      ? `Лимиты ${subject}${problem ? `: ${problem}` : ''}`
      : `Лимит ${subject}: осталось ${remaining}%${accounts.length > 1 ? ` · аккаунт #${account.index} из ${accounts.length}` : ''}`

  return jsxs(Popover, {
    onOpenChange: next => {
      setOpen(next)

      if (next) {
        refreshIfStale()
      }
    },
    open,
    children: [
      jsx(Tip, {
        label: tip,
        children: jsx(PopoverTrigger, {
          asChild: true,
          children: jsxs(Button, {
            'aria-label': tip,
            className: cn(
              'h-(--composer-control-size) shrink-0 gap-1 rounded-md px-2 text-xs font-normal',
              'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
            ),
            type: 'button',
            variant: 'ghost',
            children: [
              jsx(Ring, { remaining }),
              jsx('span', {
                style: {
                  color: remaining !== null && remaining <= LOW_REMAINING ? toneColor(remaining) : undefined,
                  fontVariantNumeric: 'tabular-nums'
                },
                children: label
              })
            ]
          })
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'top',
        sideOffset: 8,
        style: { padding: 12, width: 'auto' },
        children: jsx(LimitsPanel, { state })
      })
    ]
  })
}

export default {
  id: 'codex-limits',
  name: 'Codex Limits',
  register(ctx) {
    rest = (path, opts) => ctx.rest(path, opts)

    ctx.register({
      id: 'chip',
      area: 'composer.actions',
      order: 100,
      render: () => jsx(LimitsChip, {})
    })
  }
}
