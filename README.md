# Codex Limits — Hermes plugin

**[English](#english) · [Русский](#русский)**

A chip right before the model picker in the Hermes Desktop composer that shows how much model
quota is left. Click it for every account, every rate-limit window and when it resets.

---

## English

### What it shows

- **CLIProxyAPI pool** — if you route models through a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
  pool running next to the Hermes backend, every Codex and Claude account in it: 5-hour and weekly
  windows (plus Claude's Opus/Sonnet weeks), remaining %, time to reset, disabled/expired state.
  The chip shows the **mean remaining quota of the accounts that serve the current model**
  (GPT models → Codex accounts; Claude / Opus / Sonnet / Fable → Claude accounts).
- **Hermes's own accounts** — the backend's `openai-codex` credential pool (one block per entry).

Everything is **read-only**: the plugin never selects, rotates or refreshes anything.

### Requirements

- Hermes Desktop + a Hermes backend (local or remote). Tested with client/backend v0.21.3.
- `python3` on the backend host (standard library only).
- For the pool view: CLIProxyAPI running **on the same machine / container as the Hermes backend**.
  The pool itself does not need to be in any repository — the plugin finds the running proxy.

### Install

**In the app (one step):** Capabilities → Plugins → **Install from Git** →
`https://github.com/artemiimillier/hermes-codex-limits` → keep both **Agent plugin** and
**Desktop UI** checked → **Install**.

- The pool view works immediately — no restart.
- The "Hermes's own accounts" block needs one backend restart (plugin API routes are mounted at
  startup). You can skip it if you only care about the pool.
- With a *local* backend the desktop half of a package is opt-in: if the chip does not appear,
  switch **Codex Limits** on in the *Desktop* column of Capabilities → Plugins.

**From the command line** (on the backend host):

```bash
hermes plugins install artemiimillier/hermes-codex-limits --enable
```

and copy `desktop/plugin.js` to `~/.hermes/desktop-plugins/codex-limits/plugin.js` on the computer
running Hermes Desktop (it hot-loads, no rebuild).

### Update

The panel shows an **"update plugin on the server (git pull)"** button when the server copy is too
old. Or on the backend host: `hermes plugins update codex-limits`. The desktop half updates by
reinstalling it (or copying the new `desktop/plugin.js`).

### How it works

```
Hermes Desktop (your computer)                   Backend host (server / container)
┌──────────────────────────────┐   gateway RPC    ┌────────────────────────────────────────────┐
│ desktop/plugin.js  (chip)    │ ── shell.exec ─▶ │ python3 …/plugins/codex-limits/pool_usage.py│
│                              │                  │   ├ finds the running CLIProxyAPI process   │
│                              │                  │   ├ reads its auth-dir (read-only)          │
│                              │ ◀─ one JSON line │   └ asks each provider's usage endpoint     │
│                              │                  │                                             │
│                              │ ── REST ───────▶ │ /api/plugins/codex-limits/usage             │
│                              │ ◀──────────────  │   (Hermes's own credential pool)            │
└──────────────────────────────┘                  └────────────────────────────────────────────┘
```

`pool_usage.py` finds the pool from the running CLIProxyAPI process (`-config` → `auth-dir`), then
`~/.cli-proxy-api`, then a bounded search of the Hermes home. It calls each account's usage
endpoint (`chatgpt.com/backend-api/wham/usage`, `api.anthropic.com/api/oauth/usage`) with the
access token **exactly as stored**.

### Security and privacy

- Tokens never leave the backend host. Only account label (e-mail), plan, window percentages and
  reset times reach the app.
- The script **never refreshes a token**: refresh tokens are single-use, and rotating one would log
  the account out of the proxy. A lapsed token is shown as "token expired" until the proxy
  refreshes it on its own schedule.
- It never writes files. The only command the chip runs is the fixed `pool_usage.py` call (and
  `git pull` of this plugin, only when you press the update button).

### Troubleshooting

| Panel says | Meaning / fix |
| --- | --- |
| `CLIProxyAPI auth directory not found` | Auto-detection failed. On the backend host write the auth directory path into `<hermes home>/plugins/codex-limits/auth-dir.txt` (one line; git-ignored, survives updates). |
| `no codex/claude auth files in the pool directory` | Only Codex and Claude OAuth accounts are supported; other providers are skipped. |
| `token expired (proxy will refresh it)` | Normal between proxy refreshes; the account is still in the pool. |
| `на сервере нет скрипта pool_usage.py` | Server copy is older than v1.1.0 — press the update button in the panel. |

The interface is in Russian.

---

## Русский

### Что показывает

- **Пул CLIProxyAPI** — если модели идут через пул CLIProxyAPI, запущенный рядом с сервером Hermes:
  каждый аккаунт Codex и Claude, окна «5 часов» и «Неделя» (у Claude ещё недели Opus/Sonnet),
  остаток в процентах и время до сброса. На кнопке — **средний остаток по аккаунтам, которые
  обслуживают текущую модель** (GPT → Codex, Claude/Opus/Sonnet/Fable → Claude).
- **Собственные аккаунты Hermes** — встроенный пул `openai-codex` сервера.

Плагин **только читает**: ничего не переключает и не обновляет.

### Что нужно

- Hermes Desktop и сервер Hermes (локальный или удалённый). Проверено на v0.21.3.
- `python3` на сервере.
- Для пула: CLIProxyAPI должен работать **на той же машине / в том же контейнере, что и Hermes**.
  Отдельный репозиторий для пула не нужен — плагин сам находит запущенный прокси.

### Установка

**В приложении, в один шаг:** Capabilities → Plugins → **Install from Git** →
`https://github.com/artemiimillier/hermes-codex-limits` → оставить отмеченными **Agent plugin** и
**Desktop UI** → **Install**.

- Пул показывается сразу, перезапуск не нужен.
- Блоку «собственные аккаунты Hermes» нужен один перезапуск сервера. Если нужен только пул — можно
  не перезапускать.
- С *локальным* сервером интерфейсная часть включается вручную: если кнопка не появилась, включите
  **Codex Limits** в колонке *Desktop* на странице Capabilities → Plugins.

**Через командную строку** на сервере:

```bash
hermes plugins install artemiimillier/hermes-codex-limits --enable
```

и скопируйте `desktop/plugin.js` в `~/.hermes/desktop-plugins/codex-limits/plugin.js` на
компьютере с Hermes Desktop.

### Обновление

Если копия на сервере устарела, в панели появится кнопка **«Обновить плагин на сервере (git pull)»**.
Либо на сервере: `hermes plugins update codex-limits`.

### Безопасность

Токены не покидают сервер; в приложение уходят только e-mail аккаунта, тариф, проценты и время
сброса. Скрипт **никогда не обновляет токены** (иначе прокси потерял бы аккаунт) и ничего не пишет
на диск.

### Если что-то не так

- `CLIProxyAPI auth directory not found` — впишите путь к папке с аккаунтами прокси одной строкой в
  `<домашняя папка hermes>/plugins/codex-limits/auth-dir.txt` на сервере.
- `token expired (proxy will refresh it)` — нормально, прокси обновит токен сам.

## License

MIT
