# Codex Limits — остаток лимитов подписок в Hermes Desktop

**[Русский](#русский) · [English](#english)**

Кнопка рядом с выбором модели в Hermes Desktop: показывает, сколько лимита
осталось на аккаунтах Claude и ChatGPT в вашем пуле. Нажмите — увидите каждый
аккаунт, окна «5 часов» / «Неделя» и когда лимит сбросится.

> **Сначала поставьте пул.** Плагин показывает аккаунты шлюза подписок
> CLIProxyAPI. Если его ещё нет — поставьте по инструкции
> [hermes-codex-pool](https://github.com/artemiimillier/hermes-codex-pool)
> (шлюз подписки Claude/ChatGPT для Hermes), войдите хотя бы в один аккаунт,
> потом возвращайтесь сюда.

## Установка за 2 минуты (Русский, пошагово)

1. Откройте **Hermes Desktop** и подключитесь к тому серверу, где стоит пул
   (к тому же, где вы работаете с агентом).
2. Слева откройте **Capabilities** (Возможности) → вкладка **Plugins**.
3. Нажмите **Install from Git** и вставьте адрес:
   `https://github.com/artemiimillier/hermes-codex-limits`
4. Оставьте отмеченными обе галочки — **Agent plugin** и **Desktop UI** — и
   нажмите **Install**.
5. Рядом с выбором модели внизу окна чата появится кнопка с процентом. Нажмите
   на неё — откроется список аккаунтов.

Не появилась кнопка? В том же списке Plugins найдите **Codex Limits** и включите
его в колонке **Desktop**. Пишет «Пул CLIProxyAPI на этом сервере не найден» —
см. «Если что-то не так» ниже.

Можно и одной фразой агенту: «Поставь плагин
`hermes plugins install artemiimillier/hermes-codex-limits --enable`», но
интерфейсную часть всё равно проще поставить кнопкой Install from Git.

---

## English

### What it shows

- **CLIProxyAPI pool** — if you route models through a [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)
  pool running next to the Hermes backend, every Codex and Claude account in it: 5-hour and weekly
  windows (plus Claude's Opus/Sonnet weeks), remaining %, time to reset, disabled/expired state.
  The chip shows the **mean remaining quota of the accounts that serve the current model**
  (GPT models → Codex accounts; Claude / Opus / Sonnet / Fable → Claude accounts).
- **Hermes's own accounts** — the backend's `openai-codex` credential pool (one block per entry).
- **Several servers** — when Hermes Desktop is connected to more than one server, the chip follows
  the server of the chat you are looking at: each server shows its own pool, cached separately,
  and the panel header names the server.

Everything is **read-only**: the plugin never selects, rotates or refreshes anything.

### What it connects to

Nothing is hard-wired to any particular server, and nothing is ever sent to the plugin's author.

- The app talks only to **the Hermes server(s) you connected yourself** (the same connection your
  chats use).
- On that server the script reads the local CLIProxyAPI files and calls the providers' own usage
  endpoints: `chatgpt.com` (Codex) and `api.anthropic.com` (Claude).
- GitHub is contacted only when you install the plugin or press **"Обновить плагин"** (update).

The only fixed values are the plugin folder name (`plugins/codex-limits`), the usual Hermes home
locations (`$HERMES_HOME`, `~/.hermes`, and `/opt/data` — the official Docker image's home) and
those two provider URLs. The plugin does not need the gateway's address or port at all: it reads
the pool's account folder directly, so a pool on any port works.

### Requirements

- Hermes Desktop + a Hermes backend (local or remote). Tested with client/backend v0.21.3.
- `python3` on the backend host (standard library only).
- For the pool view: CLIProxyAPI running **on the same machine / container as the Hermes backend**.
  Don't have one yet? Set it up first with
  [hermes-codex-pool](https://github.com/artemiimillier/hermes-codex-pool); the plugin finds its
  account folder (`$HERMES_HOME/cliproxy/auths`) and any other running CLIProxyAPI by itself.

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

Press **"Обновить плагин"** at the bottom of the panel: it fetches the latest version from GitHub
onto the server the panel is showing (`git fetch` + `git reset --hard`, so it also survives
rewritten upstream history; a git-ignored `auth-dir.txt` is kept). No restart needed for the pool
view. Or on the backend host: `hermes plugins update codex-limits`. The desktop half updates by
reinstalling it (or copying the new `desktop/plugin.js`).

Install the agent half on **every** server you want to see limits for: with several servers
connected, run "Install from Git" once per server (switch to it first).

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
- It never writes files. The only commands the chip runs are the fixed `pool_usage.py` call and,
  only when you press the update button, a `git fetch` + `git reset` of this plugin's own folder.

### Troubleshooting

| Panel says | Meaning / fix |
| --- | --- |
| `На этом сервере плагин не установлен` | The agent half is not on the server this chat belongs to. Switch to that server and run Install from Git there. |
| `Пул CLIProxyAPI на этом сервере не найден` | Auto-detection failed. On the backend host write the auth directory path into `<hermes home>/plugins/codex-limits/auth-dir.txt` (one line; git-ignored, survives updates). |
| `no codex/claude auth files in the pool directory` | Only Codex and Claude OAuth accounts are supported; other providers are skipped. |
| `token expired (proxy will refresh it)` | Normal between proxy refreshes; the account is still in the pool. |
| `На этом сервере старая версия плагина` | Server copy is older than v1.1.0 — press the update button in the panel. |

The interface is in Russian.

---

## Русский

### Что показывает

- **Пул CLIProxyAPI** — если модели идут через пул CLIProxyAPI, запущенный рядом с сервером Hermes:
  каждый аккаунт Codex и Claude, окна «5 часов» и «Неделя» (у Claude ещё недели Opus/Sonnet),
  остаток в процентах и время до сброса. На кнопке — **средний остаток по аккаунтам, которые
  обслуживают текущую модель** (GPT → Codex, Claude/Opus/Sonnet/Fable → Claude).
- **Собственные аккаунты Hermes** — встроенный пул `openai-codex` сервера.
- **Несколько серверов** — если Hermes Desktop подключён к нескольким серверам, кнопка показывает
  сервер того чата, который у вас открыт. У каждого сервера свои данные, в заголовке панели
  написано, какой это сервер.

Плагин **только читает**: ничего не переключает и не обновляет.

### Куда плагин подключается

Ни к какому конкретному серверу он не привязан и ничего не отправляет автору плагина.

- Приложение обращается только к **тем серверам Hermes, которые вы подключили сами** (через то же
  подключение, что и ваши чаты).
- На сервере скрипт читает локальные файлы CLIProxyAPI и спрашивает остаток у самих провайдеров:
  `chatgpt.com` (Codex) и `api.anthropic.com` (Claude).
- На GitHub плагин ходит только при установке и когда вы нажимаете «Обновить плагин».

### Что нужно

- Hermes Desktop и сервер Hermes (локальный или удалённый). Проверено на v0.21.3.
- `python3` на сервере.
- Для пула: CLIProxyAPI должен работать **на той же машине / в том же контейнере, что и Hermes**.
  Ещё нет пула — поставьте его по [hermes-codex-pool](https://github.com/artemiimillier/hermes-codex-pool).
  Плагин сам находит папку аккаунтов (`$HERMES_HOME/cliproxy/auths` или папку запущенного
  прокси). Адрес и порт шлюза плагину не нужны.

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

Кнопка **«Обновить плагин»** внизу панели скачивает свежую версию с GitHub на тот сервер, который
сейчас показан в панели. Перезапуск не нужен. Либо на сервере: `hermes plugins update codex-limits`.

Серверную часть нужно поставить на **каждый** сервер, лимиты которого хотите видеть: переключитесь
на сервер и сделайте Install from Git.

### Безопасность

Токены не покидают сервер; в приложение уходят только e-mail аккаунта, тариф, проценты и время
сброса. Скрипт **никогда не обновляет токены** (иначе прокси потерял бы аккаунт) и ничего не пишет
на диск.

### Если что-то не так

- `На этом сервере плагин не установлен` — переключитесь на этот сервер и сделайте Install from Git.
- `Пул CLIProxyAPI на этом сервере не найден` — скажите агенту: «впиши путь к папке аккаунтов
  пула одной строкой в `<домашняя папка hermes>/plugins/codex-limits/auth-dir.txt`» (для пула
  из hermes-codex-pool это `$HERMES_HOME/cliproxy/auths`).
- `no codex/claude auth files in the pool directory` — пул найден, но в нём ещё нет ни одного
  аккаунта: войдите в аккаунт по инструкции пула.
- `token expired (proxy will refresh it)` — нормально, прокси обновит токен сам.

## License

MIT
