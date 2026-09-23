/**
 * Codex Limits — a chip before the composer's model pill showing how much
 * model quota is left; click for every account and every rate-limit window.
 *
 * Everything is read from the Hermes server the FOCUSED CHAT belongs to (the
 * app can hold several servers at once): requests go to that server, results
 * are cached per (server, profile), and switching servers switches the data.
 *
 * Sources on that server, all read-only, merged into one panel:
 *   1. POOL — the accounts of a CLIProxyAPI pool on the server host. Read by
 *      running the agent package's `pool_usage.py` through the gateway's
 *      `shell.exec` RPC (the app's own `!cmd`), so the script can be updated
 *      with a `git fetch` and no backend restart. Tokens never leave the host.
 *   2. HERMES — the server's own credential pool, from this plugin's REST
 *      route (`/api/plugins/codex-limits/usage`) when the server is the
 *      active connection, else from the core `session.usage` RPC.
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
const ROUTES_TTL_MS = 60_000
const WIDE_PANEL_FROM = 4
const LOW_REMAINING = 25
const CRITICAL_REMAINING = 10
const REPO_URL = 'https://github.com/artemiimillier/hermes-codex-limits'

const WINDOW_LABELS = {
  Session: '5 часов',
  Weekly: 'Неделя',
  'Current session': '5 часов',
  'Current week': 'Неделя',
  'Opus week': 'Opus, неделя',
  'Sonnet week': 'Sonnet, неделя'
}

const KIND_LABELS = { codex: 'Codex · GPT', claude: 'Claude' }

// Shell run on the SERVER host. Plain strings, not template literals: `$…`
// here is shell syntax. The agent package lives in `<hermes home>/plugins/`;
// try the server's own HERMES_HOME, then the default home, then the Docker one.
const HOMES = '"$HERMES_HOME" "$HOME/.hermes" /opt/data'
const EXIT_OLD_VERSION = 2
const EXIT_NOT_INSTALLED = 3
const POOL_COMMAND =
  'o=; for d in ' + HOMES + '; do p="$d/plugins/codex-limits"; ' +
  'if [ -f "$p/pool_usage.py" ]; then exec python3 "$p/pool_usage.py"; fi; ' +
  'if [ -d "$p" ]; then o=1; fi; done; ' +
  'if [ -n "$o" ]; then echo "codex-limits: pool_usage.py: No such file (old version)" >&2; exit ' + EXIT_OLD_VERSION + '; fi; ' +
  'echo "codex-limits: not installed on this server" >&2; exit ' + EXIT_NOT_INSTALLED
// fetch + reset, not pull: the repo's history may be rewritten upstream, and a
// plugin folder holds no local edits (a git-ignored auth-dir.txt survives).
const UPDATE_COMMAND =
  'for d in ' + HOMES + '; do p="$d/plugins/codex-limits"; ' +
  'if [ -d "$p/.git" ]; then cd "$p" && git fetch -q --depth 1 origin HEAD && git reset -q --hard FETCH_HEAD && git log -1 --format=%h; exit $?; fi; done; ' +
  'echo "codex-limits: plugin folder with .git not found on this server" >&2; exit 2'

// ---------------------------------------------------------------------------
// Which server: the focused chat's owner (connection + profile), else the
// active gateway. `isActive` → the live socket and `ctx.rest` reach it.
// ---------------------------------------------------------------------------

const ACTIVE = 'active'

const normProfile = profile => String(profile || 'default').trim().toLowerCase() || 'default'

function targetFrom(owner, activeConnectionId, activeProfile) {
  const active = activeConnectionId || null
  const connectionId = owner?.connectionId || active || ACTIVE
  const profile = normProfile(owner?.profile || activeProfile)
  const sameConnection = !owner?.connectionId || !active || owner.connectionId === active
  const isActive = sameConnection && profile === normProfile(activeProfile)

  return { connectionId, profile, isActive, key: `${connectionId}::${profile}` }
}

const labels = new Map()
let labelsLoading = null

function loadLabels() {
  labelsLoading ??= Promise.resolve()
    .then(() => host.connections?.())
    .then(rows => {
      for (const row of rows ?? []) {
        labels.set(row.id, row.label || row.id)
      }
    })
    .catch(() => undefined)
    .finally(() => {
      labelsLoading = null
      notify()
    })

  return labelsLoading
}

function serverLabel(connectionId) {
  if (connectionId === 'local') {
    return 'этот компьютер'
  }

  return labels.get(connectionId) ?? (connectionId === ACTIVE ? 'текущий сервер' : connectionId)
}

let routesCache = { at: 0, value: null }

async function routeFor(target) {
  if (typeof host.profileRoutes !== 'function' || typeof host.requestProfile !== 'function') {
    return null
  }

  if (!routesCache.value || Date.now() - routesCache.at > ROUTES_TTL_MS) {
    routesCache = { at: Date.now(), value: await host.profileRoutes() }
  }

  const routes = (routesCache.value ?? []).filter(route => route.connectionId === target.connectionId)

  return (
    routes.find(route => normProfile(route.targetProfile) === target.profile || normProfile(route.profile) === target.profile) ??
    routes[0] ??
    null
  )
}

/** Gateway RPC to the target server: the live socket when it is the active
 *  one, else a routed (pooled) socket to that connection. */
async function rpc(target, method, params, timeoutMs) {
  if (target.isActive) {
    return host.request(method, params, timeoutMs)
  }

  const route = await routeFor(target)

  if (!route) {
    throw new Error(`нет связи с сервером «${serverLabel(target.connectionId)}»`)
  }

  return host.requestProfile(route, method, params, timeoutMs)
}

// ---------------------------------------------------------------------------
// One slot per (server, profile) and one shared current target for every
// mounted chip (split tiles mount several composers).
// ---------------------------------------------------------------------------

let rest = null
let current = null
let sessionId = null
let mounted = 0
let pollTimer = null
const listeners = new Set()
const slots = new Map()
const EMPTY = { status: 'idle', data: null, error: null, at: 0 }
const NO_SESSION = 'no-session'

function slotOf(key) {
  let slot = slots.get(key)

  if (!slot) {
    slot = { snapshot: EMPTY, pool: { at: 0, value: null }, restMissing: false, inflight: null }
    slots.set(key, slot)
  }

  return slot
}

function notify() {
  listeners.forEach(listener => listener())
}

function publish(key, next) {
  const slot = slotOf(key)

  slot.snapshot = { ...slot.snapshot, ...next }
  notify()
}

function subscribe(listener) {
  listeners.add(listener)

  return () => listeners.delete(listener)
}

function readSnapshot() {
  return current ? slotOf(current.key).snapshot : EMPTY
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

/** `shell.exec` result of POOL_COMMAND → pool state. */
function parsePoolResult(result) {
  const line = String(result?.stdout ?? '').trim().split('\n').pop() ?? ''
  const stderr = String(result?.stderr ?? '').trim()

  if (line.startsWith('{')) {
    const parsed = JSON.parse(line)

    return {
      ok: Boolean(parsed.ok),
      total: parsed.n ?? parsed.accounts?.length ?? 0,
      error: parsed.error ?? null,
      accounts: (parsed.accounts ?? []).map(poolAccount)
    }
  }

  if (result?.code === EXIT_NOT_INSTALLED || /not installed on this server/i.test(stderr)) {
    return { ok: false, notInstalled: true, total: 0, error: null, accounts: [] }
  }

  if (result?.code === EXIT_OLD_VERSION || /no such file|can't open file/i.test(stderr)) {
    return { ok: false, missing: true, total: 0, error: null, accounts: [] }
  }

  return { ok: false, total: 0, error: stderr.slice(-160) || `pool_usage.py завершился с кодом ${result?.code}`, accounts: [] }
}

async function fetchPool(target, slot, force) {
  if (!force && slot.pool.value && Date.now() - slot.pool.at < STALE_MS) {
    return slot.pool.value
  }

  const value = parsePoolResult(await rpc(target, 'shell.exec', { command: POOL_COMMAND }, 40_000))

  slot.pool = { at: Date.now(), value }

  return value
}

/** Refresh the agent package on the target server so the newest `pool_usage.py` runs. User-initiated only. */
async function updateServerPlugin() {
  const target = current

  if (!target) {
    return null
  }

  const result = await rpc(target, 'shell.exec', { command: UPDATE_COMMAND }, 40_000)

  if (result?.code !== 0) {
    throw new Error(String(result?.stderr || result?.stdout || 'обновление не удалось').trim().slice(-200))
  }

  slotOf(target.key).pool = { at: 0, value: null }
  await refresh(true)

  return String(result?.stdout ?? '').trim()
}

// ── source 2: the server's own account(s) ──────────────────────────────────

// `session.usage` renders the account block as text (the `/usage` lines):
//   Provider: openai-codex (Plus)
//   Weekly: 60% remaining (40% used) • resets in 4d 22h (2030-01-01 12:00 UTC)
//   Extra: unavailable • n/a
//   Credits balance: $0.00
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

async function fetchViaGateway(target) {
  if (!sessionId) {
    return { provider: null, accounts: [], note: NO_SESSION }
  }

  const usage = await rpc(target, 'session.usage', { session_id: sessionId }, 45_000)
  const account = parseAccountLines(usage?.account_lines)

  if (!account) {
    return { provider: null, accounts: [], note: 'сервер не прислал лимиты своих аккаунтов' }
  }

  return { provider: account.provider, accounts: [account], source: 'gateway' }
}

async function fetchHermes(target, slot, force) {
  // `ctx.rest` always addresses the ACTIVE connection, so it is only valid for it.
  if (target.isActive && !slot.restMissing) {
    try {
      return await rest(`/usage${force ? '?force=true' : ''}`, { timeoutMs: 45_000 })
    } catch (error) {
      if (!/\b404\b/.test(String(error?.message || error))) {
        throw error
      }

      // The route exists only where the agent package is installed + mounted.
      slot.restMissing = true
    }
  }

  return fetchViaGateway(target)
}

// ── merge ──────────────────────────────────────────────────────────────────

const messageOf = error => String(error?.message || error)

/** Both halves are optional and fail independently. */
async function fetchLimits(target, slot, force) {
  if (force) {
    slot.restMissing = false
  }

  const [pool, hermes] = await Promise.allSettled([fetchPool(target, slot, force), fetchHermes(target, slot, force)])

  return {
    pool: pool.status === 'fulfilled' ? pool.value : { ok: false, total: 0, accounts: [], error: messageOf(pool.reason) },
    hermes: hermes.status === 'fulfilled' ? hermes.value : { provider: null, accounts: [], note: messageOf(hermes.reason) }
  }
}

function refresh(force = false) {
  const target = current

  if (!rest || !target) {
    return Promise.resolve()
  }

  const slot = slotOf(target.key)

  if (slot.inflight) {
    return slot.inflight
  }

  publish(target.key, { status: slot.snapshot.data ? 'refreshing' : 'loading' })
  slot.inflight = fetchLimits(target, slot, force)
    .then(data => publish(target.key, { status: 'ready', data, error: null, at: Date.now() }))
    .catch(error => {
      const message = messageOf(error)

      // Lands in ~/.hermes/logs/desktop.log — the only trace a chip failure
      // leaves. Once per distinct failure: the poll would otherwise repeat it.
      if (slot.snapshot.error !== message) {
        console.error('[codex-limits] usage fetch failed:', message)
      }

      publish(target.key, { status: 'error', error: message, at: Date.now() })
    })
    .finally(() => {
      slot.inflight = null
    })

  return slot.inflight
}

function refreshIfStale() {
  if (current && Date.now() - slotOf(current.key).snapshot.at > STALE_MS) {
    void refresh()
  }
}

/** Follow the focused chat's server; switching servers shows that server's
 *  cached data at once and re-reads it when stale. */
function useTarget() {
  const owner = useValue(host.state.focusedSessionOwner)
  const activeConnectionId = useValue(host.state.connectionId)
  const activeProfile = useValue(host.state.profile)
  const focused = useValue(host.state.focusedSessionId)
  const activeSession = useValue(host.state.activeSessionId)
  const target = targetFrom(owner, activeConnectionId, activeProfile)

  useEffect(() => {
    const changed = current?.key !== target.key || current?.isActive !== target.isActive

    current = target

    if (!labels.has(target.connectionId) && target.connectionId !== ACTIVE) {
      void loadLabels()
    }

    if (changed) {
      notify()
      refreshIfStale()
    }
  }, [target.key, target.isActive])

  useEffect(() => {
    sessionId = focused ?? activeSession ?? null

    // The own-account fallback needs a live chat; fetch as soon as one exists.
    if (sessionId && current && slotOf(current.key).snapshot.data?.hermes?.note === NO_SESSION) {
      void refresh()
    }
  }, [focused, activeSession])

  return target
}

function usePolling() {
  useEffect(() => {
    mounted += 1
    pollTimer ??= setInterval(() => void refresh(), POLL_MS)

    return () => {
      mounted -= 1

      if (mounted === 0 && pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }
  }, [])
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
const SECTION = { ...SPREAD, borderBottom: '1px solid var(--chrome-action-hover)', paddingBottom: 4 }
const DANGER = 'var(--ui-red, #e5484d)'

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

function PoolSection({ pool, model, update }) {
  if (pool.notInstalled) {
    return jsxs('div', {
      style: { display: 'grid', gap: 4 },
      children: [
        jsx('div', { children: 'На этом сервере плагин не установлен.' }),
        jsx('div', {
          style: MUTED,
          children: `Capabilities → Plugins → Install from Git → ${REPO_URL}`
        })
      ]
    })
  }

  if (pool.missing) {
    return jsxs('div', {
      style: { display: 'grid', gap: 6 },
      children: [
        jsx('div', { style: MUTED, children: 'На этом сервере старая версия плагина — в ней нет чтения пула.' }),
        jsx(Button, {
          className: 'h-6 justify-self-start px-2 text-xs font-normal',
          disabled: update.busy,
          onClick: update.run,
          type: 'button',
          variant: 'outline',
          children: update.busy ? 'Обновляю…' : 'Обновить плагин на сервере'
        })
      ]
    })
  }

  if (!pool.accounts.length) {
    if (!pool.error) {
      return null
    }

    return jsx('div', {
      style: MUTED,
      children: /auth directory not found/i.test(pool.error)
        ? 'Пул CLIProxyAPI на этом сервере не найден.'
        : `Пул CLIProxyAPI: ${pool.error}`
    })
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
              style: SECTION,
              children: [
                jsx('span', { style: { fontWeight: 600 }, children: `${KIND_LABELS[kind] ?? kind} · ${accounts.length}` }),
                jsx('span', {
                  style: { ...MUTED, color: toneColor(summary.remaining) },
                  children: summary.remaining === null ? 'нет данных' : `в среднем ${summary.remaining}% · живых ${summary.alive}`
                })
              ]
            }),
            jsx('div', {
              // One column in a narrow panel, two side by side once it is wide.
              style: {
                alignItems: 'start',
                display: 'grid',
                gap: '12px 20px',
                gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))'
              },
              children: accounts.map(account => jsx(PoolAccountRow, { account }, account.id))
            })
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
                style: { ...MUTED, color: exhausted ? DANGER : MUTED.color },
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

function HermesSection({ hermes, hasPool }) {
  const accounts = hermes?.accounts ?? []

  if (!accounts.length) {
    // Normal on a server without its own provider account; only worth a line
    // when there is nothing else to show.
    if (hasPool || !hermes?.note) {
      return null
    }

    return jsx('div', {
      style: MUTED,
      children: hermes.note === NO_SESSION ? 'Откройте любой чат этого сервера, чтобы подтянуть его лимиты.' : hermes.note
    })
  }

  const provider = hermes.provider
  const title = !provider || provider === 'openai-codex' ? 'Codex' : provider

  return jsxs('div', {
    style: { display: 'grid', gap: 10 },
    children: [
      jsx('div', { style: { ...SECTION, fontWeight: 600 }, children: `Свой аккаунт Hermes · ${title}` }),
      ...accounts.map(account => jsx(AccountBlock, { account, showIdentity: accounts.length > 1 || hasPool }, account.id ?? account.index)),
      hermes.source === 'gateway'
        ? jsx('div', { style: { ...MUTED, color: 'var(--ui-text-quaternary)' }, children: 'Аккаунт, на котором работает этот чат.' })
        : null
    ]
  })
}

function LimitsPanel({ state, model, server }) {
  const [updating, setUpdating] = useState(false)
  const [updateMessage, setUpdateMessage] = useState(null)
  const pool = state.data?.pool ?? { accounts: [] }
  const hermes = state.data?.hermes ?? null
  const hasPool = pool.accounts.length > 0
  const working = state.status === 'loading' || state.status === 'refreshing'
  const nothingYet = !state.data && state.status !== 'error'

  const update = {
    busy: updating,
    run: () => {
      setUpdating(true)
      setUpdateMessage(null)
      updateServerPlugin()
        .then(sha => setUpdateMessage({ ok: true, text: sha ? `Плагин на сервере обновлён (${sha}).` : 'Плагин на сервере обновлён.' }))
        .catch(error => setUpdateMessage({ ok: false, text: messageOf(error) }))
        .finally(() => setUpdating(false))
    }
  }

  // A big pool gets a wide, two-column panel; the height follows the room the
  // popover actually has above the composer (Radix publishes it), not a fixed vh.
  const wide = pool.accounts.length > WIDE_PANEL_FROM

  return jsxs('div', {
    style: {
      display: 'grid',
      fontSize: '0.75rem',
      gap: 12,
      maxHeight: 'calc(var(--radix-popover-content-available-height, 85vh) - 28px)',
      overflowY: 'auto',
      paddingRight: 4,
      width: wide ? 'min(720px, calc(100vw - 48px))' : 'min(380px, calc(100vw - 48px))'
    },
    children: [
      jsxs('div', {
        style: { display: 'grid', gap: 2 },
        children: [
          jsx('span', { style: { fontWeight: 600 }, children: hasPool ? `Лимиты пула · ${pool.total ?? pool.accounts.length} акк.` : 'Лимиты' }),
          jsx('span', { style: MUTED, children: `Сервер: ${server}` })
        ]
      }),
      state.status === 'error'
        ? jsx('div', { style: { color: DANGER }, children: `Не удалось получить лимиты: ${state.error}` })
        : null,
      nothingYet ? jsx('div', { style: { color: 'var(--ui-text-tertiary)' }, children: 'Загружаю…' }) : null,
      jsx(PoolSection, { model, pool, update }),
      jsx(HermesSection, { hasPool, hermes }),
      updateMessage
        ? jsx('div', { style: { ...MUTED, color: updateMessage.ok ? MUTED.color : DANGER }, children: updateMessage.text })
        : null,
      jsxs('div', {
        style: {
          alignItems: 'center',
          borderTop: '1px solid var(--chrome-action-hover)',
          color: 'var(--ui-text-quaternary)',
          display: 'flex',
          fontSize: '0.6875rem',
          gap: 6,
          justifyContent: 'space-between',
          paddingTop: 8
        },
        children: [
          jsx('span', { children: state.at ? `обновлено в ${formatClock(state.at)}` : '' }),
          jsxs('span', {
            style: { display: 'flex', gap: 2 },
            children: [
              state.data && !pool.notInstalled
                ? jsx(Button, {
                    className: 'h-6 px-1.5 text-xs font-normal',
                    disabled: updating || working,
                    onClick: update.run,
                    title: 'Скачать свежую версию плагина с GitHub на этот сервер',
                    type: 'button',
                    variant: 'ghost',
                    children: updating ? 'Обновляю плагин…' : 'Обновить плагин'
                  })
                : null,
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
    ]
  })
}

function LimitsChip() {
  const target = useTarget()
  const state = useSyncExternalStore(subscribe, readSnapshot)
  const model = useValue(host.state.model)
  const [open, setOpen] = useState(false)

  usePolling()
  useRefreshAfterTurn()

  const server = serverLabel(target.connectionId)
  const poolAccounts = state.data?.pool?.accounts ?? []
  const ownAccounts = state.data?.hermes?.accounts ?? []
  const summary = poolAccounts.length ? poolSummary(poolAccounts, model) : null
  const account = activeAccount(ownAccounts)
  const remaining = summary ? summary.remaining : tightest(account)
  const loading = !state.data && (state.status === 'idle' || state.status === 'loading')
  const label = remaining === null ? (loading ? '…' : '—') : `${remaining}%`

  const detail = summary
    ? `пул${summary.family ? ` ${KIND_LABELS[summary.family]}` : ''}: в среднем осталось ${summary.remaining ?? '—'}% · живых аккаунтов ${summary.alive} из ${summary.total}`
    : remaining !== null
      ? `осталось ${remaining}%`
      : state.data?.pool?.notInstalled
        ? 'плагин на этом сервере не установлен'
        : state.status === 'error'
          ? state.error
          : 'нет данных'
  const tip = `Лимиты · ${server}: ${detail}`

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
        children: jsx(LimitsPanel, { model, server, state })
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
