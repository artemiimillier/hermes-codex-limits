/**
 * Codex Limits — a chip before the composer's model pill showing how much
 * model quota is left; click for every account and every rate-limit window.
 *
 * Three sources, all read-only, merged into one panel:
 *   1. POOL — the accounts of a CLIProxyAPI pool on the backend host. Read by
 *      running the agent package's `pool_usage.py` through the gateway's
 *      `shell.exec` RPC (the app's own `!cmd`), so the script can be updated
 *      with a `git pull` and no backend restart. Tokens never leave the host.
 *   2. HERMES — the backend's own credential pool, from this plugin's REST
 *      route (`/api/plugins/codex-limits/usage`, agent package
 *      `~/.hermes/plugins/codex-limits/dashboard/plugin_api.py`).
 *   3. Fallback for (2) on a backend without the agent package: the core
 *      `session.usage` RPC (one account — the one the focused chat runs on).
 *
 * Ships as the package's `desktop/plugin.js`, so "Install from Git" in the app
 * installs it together with the agent half; a hand-copied
 * `~/.hermes/desktop-plugins/codex-limits/plugin.js` works the same way. Plain
 * ESM with `jsx()` calls — loaded at runtime, so only Tailwind classes core
 * already ships are used; everything custom is an inline style.
 */

import { Button, cn, host, icons, Popover, PopoverContent, PopoverTrigger, Tip, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const STALE_MS = 60_000
const POLL_MS = 5 * 60_000
const AFTER_TURN_DELAY_MS = 4_000
const LOW_REMAINING = 25
const CRITICAL_REMAINING = 10

const WINDOW_LABELS = {
  Session: '5 часов',
  Weekly: 'Неделя',
  'Current session': '5 часов',
  'Current week': 'Неделя',
  'Opus week': 'Opus, неделя',
  'Sonnet week': 'Sonnet, неделя'
}

const KIND_LABELS = { codex: 'Codex · GPT', claude: 'Claude' }

// Shell run on the BACKEND host. Plain strings, not template literals: `$…`
// here is shell syntax. The agent package lives in `<hermes home>/plugins/`;
// try the backend's own HERMES_HOME, then the default home, then the Docker one.
const HOMES = '"$HERMES_HOME" "$HOME/.hermes" /opt/data'
const POOL_COMMAND =
  'for d in ' + HOMES + '; do f="$d/plugins/codex-limits/pool_usage.py"; ' +
  'if [ -f "$f" ]; then exec python3 "$f"; fi; done; ' +
  'echo "pool_usage.py: No such file" >&2; exit 2'
const POOL_UPDATE_COMMAND =
  'for d in ' + HOMES + '; do p="$d/plugins/codex-limits"; ' +
  'if [ -d "$p/.git" ]; then exec git -C "$p" pull --ff-only; fi; done; ' +
  'echo "codex-limits: plugin folder with .git not found on the server" >&2; exit 2'

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
// The pool script asks every account's provider — reuse a fresh answer.
let poolCache = { at: 0, value: null }

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

// ── source 1: the CLIProxyAPI pool, via shell.exec ─────────────────────────

/** `pool_usage.py` row → the account shape the panel renders. */
function poolAccount(row) {
  const windows = (row.w ?? []).map(([label, used, reset]) => ({
    label,
    used_percent: typeof used === 'number' ? used : null,
    resets_at: typeof reset === 'number' ? new Date(reset * 1000).toISOString() : null
  }))

  return {
    index: row.i,
    id: `pool-${row.t}-${row.i}`,
    kind: row.t,
    label: row.l,
    plan: row.p ?? null,
    disabled: Boolean(row.off),
    available: !row.off && !row.e && windows.length > 0,
    unavailable_reason: row.off ? 'отключён в прокси' : row.e || (windows.length ? null : 'нет данных о лимитах'),
    windows,
    details: row.d ?? []
  }
}

async function fetchPool(force) {
  if (!force && poolCache.value && Date.now() - poolCache.at < STALE_MS) {
    return poolCache.value
  }

  const result = await host.request('shell.exec', { command: POOL_COMMAND }, 40_000)
  const line = String(result?.stdout ?? '').trim().split('\n').pop() ?? ''
  let value

  if (line.startsWith('{')) {
    const parsed = JSON.parse(line)

    value = {
      ok: Boolean(parsed.ok),
      total: parsed.n ?? parsed.accounts?.length ?? 0,
      error: parsed.error ?? null,
      accounts: (parsed.accounts ?? []).map(poolAccount)
    }
  } else {
    const stderr = String(result?.stderr ?? '').trim()

    // No script on the host yet: the agent package predates it (or is absent).
    value = /no such file|can't open file/i.test(stderr)
      ? { ok: false, missing: true, total: 0, error: null, accounts: [] }
      : { ok: false, total: 0, error: stderr.slice(-160) || `pool_usage.py завершился с кодом ${result?.code}`, accounts: [] }
  }

  poolCache = { at: Date.now(), value }

  return value
}

/** Pull the agent package on the backend host so `pool_usage.py` appears. User-initiated only. */
async function updateBackendPackage() {
  const result = await host.request('shell.exec', { command: POOL_UPDATE_COMMAND }, 40_000)

  if (result?.code !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || 'git pull не удался').trim().slice(-200))
  }

  poolCache = { at: 0, value: null }

  return refresh(true)
}

// ── sources 2 + 3: the backend's own account(s) ────────────────────────────

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

async function fetchHermes(force) {
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

// ── merge ──────────────────────────────────────────────────────────────────

/** Both halves are optional; only a total blank is an error. */
async function fetchLimits(force) {
  const [pool, hermes] = await Promise.allSettled([fetchPool(force), fetchHermes(force)])
  const poolValue = pool.status === 'fulfilled' ? pool.value : { ok: false, total: 0, accounts: [], error: String(pool.reason?.message || pool.reason) }

  if (hermes.status === 'rejected' && !poolValue.accounts.length) {
    throw hermes.reason
  }

  const hermesValue = hermes.status === 'fulfilled' ? hermes.value : { provider: null, accounts: [] }

  return { ...hermesValue, pool: poolValue }
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

/** Which pool accounts serve this model: GPT-family → codex logins, Claude-family → claude logins. */
function familyOf(model) {
  const slug = String(model ?? '').toLowerCase()

  if (/claude|opus|sonnet|haiku|fable/.test(slug)) {
    return 'claude'
  }

  return /gpt|codex|\bo\d/.test(slug) ? 'codex' : null
}

/** Pool gauge for the chip: the mean of every readable account's tightest
 *  window (a proxy rotates across accounts, so no single one is "current"). */
function poolSummary(accounts, model) {
  const family = familyOf(model)
  const scoped = accounts.filter(account => account.kind === family)
  const group = scoped.length ? scoped : accounts
  const readable = group.map(tightest).filter(value => value !== null)

  if (!readable.length) {
    return { remaining: null, alive: 0, total: group.length, family: scoped.length ? family : null }
  }

  return {
    remaining: Math.round(readable.reduce((sum, value) => sum + value, 0) / readable.length),
    alive: readable.filter(value => value > 0).length,
    total: group.length,
    family: scoped.length ? family : null
  }
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

function formatCountdown(iso, { short = false } = {}) {
  const ms = new Date(iso).getTime() - Date.now()

  if (!Number.isFinite(ms)) {
    return ''
  }

  if (ms <= 0) {
    return short ? 'вот-вот' : 'сброс вот-вот'
  }

  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const parts = days ? [`${days} д`, `${hours} ч`] : hours ? [`${hours} ч`, `${minutes % 60} мин`] : [`${minutes} мин`]

  return short ? parts.join(' ') : `сброс через ${parts.join(' ')}`
}

const formatMoment = iso =>
  new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

const formatClock = ms => new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const MUTED = { color: 'var(--ui-text-tertiary)', fontSize: '0.6875rem' }
const SPREAD = { alignItems: 'baseline', display: 'flex', gap: 12, justifyContent: 'space-between' }

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

function Bar({ remaining }) {
  return jsx('div', {
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
  })
}

function WindowRow({ window }) {
  const remaining = remainingOf(window)
  const label = WINDOW_LABELS[window.label] ?? window.label

  return jsxs('div', {
    style: { display: 'grid', gap: 4 },
    children: [
      jsxs('div', {
        style: SPREAD,
        children: [
          jsx('span', { style: { color: 'var(--ui-text-secondary)' }, children: label }),
          jsx('span', {
            style: { color: toneColor(remaining), fontVariantNumeric: 'tabular-nums', fontWeight: 600 },
            children: remaining === null ? 'нет данных' : `осталось ${remaining}%`
          })
        ]
      }),
      jsx(Bar, { remaining }),
      window.resets_at
        ? jsx('div', { style: MUTED, children: `${formatCountdown(window.resets_at)} · ${formatMoment(window.resets_at)}` })
        : window.detail
          ? jsx('div', { style: MUTED, children: window.detail })
          : null
    ]
  })
}

/** One line per window — a pool lists many accounts, so rows stay dense. */
function CompactWindowRow({ window }) {
  const remaining = remainingOf(window)

  return jsxs('div', {
    style: { alignItems: 'center', display: 'grid', gap: 8, gridTemplateColumns: '84px 1fr 38px 78px' },
    children: [
      jsx('span', { style: { ...MUTED, color: 'var(--ui-text-secondary)' }, children: WINDOW_LABELS[window.label] ?? window.label }),
      jsx(Bar, { remaining }),
      jsx('span', {
        style: { color: toneColor(remaining), fontVariantNumeric: 'tabular-nums', fontWeight: 600, textAlign: 'right' },
        children: remaining === null ? '—' : `${remaining}%`
      }),
      jsx('span', {
        style: { ...MUTED, textAlign: 'right' },
        title: window.resets_at ? `сброс ${formatMoment(window.resets_at)}` : undefined,
        children: window.resets_at ? formatCountdown(window.resets_at, { short: true }) : ''
      })
    ]
  })
}

function PoolAccountRow({ account }) {
  return jsxs('div', {
    style: { display: 'grid', gap: 4, opacity: account.disabled ? 0.55 : 1 },
    children: [
      jsxs('div', {
        style: SPREAD,
        children: [
          jsx('span', {
            style: { fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            children: account.label
          }),
          account.plan ? jsx('span', { style: MUTED, children: account.plan }) : null
        ]
      }),
      ...account.windows.map(window => jsx(CompactWindowRow, { window }, window.label)),
      account.unavailable_reason ? jsx('div', { style: MUTED, children: account.unavailable_reason }) : null,
      ...account.details.map(line => jsx('div', { style: MUTED, children: line }, line))
    ]
  })
}

function PoolSection({ pool, model, onUpdate, updating, updateError }) {
  if (pool.missing) {
    return jsxs('div', {
      style: { display: 'grid', gap: 6 },
      children: [
        jsx('div', {
          style: MUTED,
          children: 'Пул CLIProxyAPI: на сервере нет скрипта pool_usage.py — серверная часть плагина старая.'
        }),
        jsx(Button, {
          className: 'h-6 justify-self-start px-2 text-xs font-normal',
          disabled: updating,
          onClick: onUpdate,
          type: 'button',
          variant: 'outline',
          children: updating ? 'Обновляю…' : 'Обновить плагин на сервере (git pull)'
        }),
        updateError ? jsx('div', { style: { ...MUTED, color: 'var(--ui-red, #e5484d)' }, children: updateError }) : null
      ]
    })
  }

  if (!pool.accounts.length) {
    return pool.error ? jsx('div', { style: MUTED, children: `Пул CLIProxyAPI: ${pool.error}` }) : null
  }

  const family = familyOf(model)
  const kinds = [...new Set(pool.accounts.map(account => account.kind))].sort(
    (a, b) => Number(b === family) - Number(a === family)
  )

  return jsxs('div', {
    style: { display: 'grid', gap: 12 },
    children: kinds.map(kind => {
      const accounts = pool.accounts.filter(account => account.kind === kind)
      const summary = poolSummary(accounts, null)

      return jsxs(
        'div',
        {
          style: { display: 'grid', gap: 10 },
          children: [
            jsxs('div', {
              style: { ...SPREAD, borderBottom: '1px solid var(--chrome-action-hover)', paddingBottom: 4 },
              children: [
                jsx('span', { style: { fontWeight: 600 }, children: `${KIND_LABELS[kind] ?? kind} · ${accounts.length}` }),
                jsx('span', {
                  style: { ...MUTED, color: toneColor(summary.remaining) },
                  children: summary.remaining === null ? 'нет данных' : `в среднем ${summary.remaining}% · живых ${summary.alive}`
                })
              ]
            }),
            ...accounts.map(account => jsx(PoolAccountRow, { account }, account.id))
          ]
        },
        kind
      )
    })
  })
}

function AccountBlock({ account, showIdentity }) {
  const exhausted = account.pool_status === 'exhausted'

  return jsxs('div', {
    style: { display: 'grid', gap: 8 },
    children: [
      showIdentity
        ? jsxs('div', {
            style: SPREAD,
            children: [
              jsx('span', {
                style: { fontWeight: 600 },
                children: `#${account.index} ${account.label || account.id || 'аккаунт'}`
              }),
              jsx('span', {
                style: { ...MUTED, color: exhausted ? 'var(--ui-red, #e5484d)' : MUTED.color },
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
      ...(account.details ?? []).map(line => jsx('div', { style: MUTED, children: line }, line))
    ]
  })
}

function LimitsPanel({ state, model }) {
  const [updating, setUpdating] = useState(false)
  const [updateError, setUpdateError] = useState(null)
  const accounts = state.data?.accounts ?? []
  const pool = state.data?.pool ?? { accounts: [] }
  const hasPool = pool.accounts.length > 0
  const pooled = accounts.length > 1
  const working = state.status === 'loading' || state.status === 'refreshing'
  const provider = state.data?.provider
  const ownTitle = !provider || provider === 'openai-codex' ? 'Codex' : provider
  const title = hasPool ? `Лимиты пула · ${pool.total ?? pool.accounts.length} акк.` : `Лимиты ${ownTitle}`
  const nothing = !accounts.length && !hasPool

  const onUpdate = () => {
    setUpdating(true)
    setUpdateError(null)
    updateBackendPackage()
      .catch(error => setUpdateError(String(error?.message || error)))
      .finally(() => setUpdating(false))
  }

  return jsxs('div', {
    style: { display: 'grid', fontSize: '0.75rem', gap: 12, maxHeight: '62vh', minWidth: 300, overflowY: 'auto', paddingRight: 2 },
    children: [
      jsxs('div', {
        style: SPREAD,
        children: [
          jsx('span', { style: { fontWeight: 600 }, children: title }),
          !hasPool && !pooled && accounts[0]?.plan ? jsx('span', { style: MUTED, children: accounts[0].plan }) : null
        ]
      }),
      state.status === 'error' && nothing
        ? jsx('div', { style: { color: 'var(--ui-red, #e5484d)' }, children: `Не удалось получить лимиты: ${state.error}` })
        : null,
      state.status === NO_SESSION && nothing
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Откройте любой чат — лимиты берутся из его сессии.' })
        : null,
      nothing && (state.status === 'idle' || working)
        ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Загружаю…' })
        : null,
      jsx(PoolSection, { model, onUpdate, pool, updateError, updating }),
      accounts.length
        ? jsxs('div', {
            style: { display: 'grid', gap: 10 },
            children: [
              hasPool
                ? jsx('div', {
                    style: { ...SPREAD, borderBottom: '1px solid var(--chrome-action-hover)', fontWeight: 600, paddingBottom: 4 },
                    children: `Hermes · свой аккаунт ${ownTitle}`
                  })
                : null,
              ...accounts.map(account =>
                jsx(AccountBlock, { account, showIdentity: pooled || hasPool }, account.id ?? account.index)
              )
            ]
          })
        : null,
      state.data?.source === 'gateway' && !hasPool
        ? jsx('div', {
            style: { ...MUTED, color: 'var(--ui-text-quaternary)' },
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
  const model = useValue(host.state.model)
  const [open, setOpen] = useState(false)

  useRefreshAfterTurn()

  const accounts = state.data?.accounts ?? []
  const poolAccounts = state.data?.pool?.accounts ?? []
  const summary = poolAccounts.length ? poolSummary(poolAccounts, model) : null
  const account = activeAccount(accounts)
  const remaining = summary ? summary.remaining : tightest(account)

  // Nothing to show for this setup (no credential anywhere) — stay out of the row.
  if (state.status === 'ready' && !account && !poolAccounts.length) {
    return null
  }

  const settled = state.status === 'error' || state.status === NO_SESSION
  const label = remaining === null ? (settled || summary ? '—' : '…') : `${remaining}%`
  const provider = state.data?.provider
  const subject = !provider || provider === 'openai-codex' ? 'Codex' : provider

  const problem =
    state.status === 'error' ? state.error : state.status === NO_SESSION ? 'откройте чат, чтобы подтянуть данные' : null

  const tip = summary
    ? `Пул${summary.family ? ` ${KIND_LABELS[summary.family]}` : ''}: в среднем осталось ${summary.remaining ?? '—'}% · живых аккаунтов ${summary.alive} из ${summary.total}`
    : remaining === null
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
        children: jsx(LimitsPanel, { model, state })
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
