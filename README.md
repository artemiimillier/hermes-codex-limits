# codex-limits — Hermes plugin

Shows how much model quota is left, right before the model picker in the Hermes Desktop composer.
Click the chip for every account, every rate-limit window and its reset time.

It understands two kinds of "pool":

- a **CLIProxyAPI pool** running on the backend host (Codex and Claude OAuth accounts) — one dense
  row per account, grouped by provider; the chip shows the mean remaining quota of the accounts
  that serve the current model's family;
- the backend's **own Hermes credential pool** (`openai-codex`) — one block per entry.

## Parts

| Part | Where it runs | Path |
| --- | --- | --- |
| Pool reader (stdlib-only CLI, one JSON line) | backend host, via the gateway's `shell.exec` RPC | `pool_usage.py` |
| Backend route `GET /api/plugins/codex-limits/usage` | the Hermes backend process | `dashboard/plugin_api.py` |
| Desktop chip | Hermes Desktop (renderer) | `desktop-standalone/plugin.js` |

Everything is read-only. `pool_usage.py` reads CLIProxyAPI's auth files and asks each provider's
own usage endpoint with the access token exactly as stored: it **never refreshes a token**
(refresh tokens are single-use — rotating one would log the account out of the proxy), never
writes a file and never prints a token. Only label, plan, window percentages and reset times leave
the host. It finds the pool from the running CLIProxyAPI process (`-config` → `auth-dir`), falling
back to `~/.cli-proxy-api` and a bounded search; override with `--auth-dir` or `CLIPROXY_AUTH_DIR`.

## Install

Backend (on the machine that runs the Hermes backend):

```bash
hermes plugins install artemiimillier/hermes-codex-limits --enable
```

The REST route is mounted at backend startup only, so it needs one restart after the first
install. `pool_usage.py` does not: it is executed fresh on every read, so later updates are just

```bash
hermes plugins update codex-limits
```

(or the "update plugin on the server" button the chip's panel shows when the script is missing).

Desktop: copy `desktop-standalone/plugin.js` to `~/.hermes/desktop-plugins/codex-limits/plugin.js`
on the computer running Hermes Desktop. It hot-loads; no rebuild. (It is deliberately not shipped
as `desktop/plugin.js`: a package's desktop half is opt-in, the standalone root is on by default.)

Without any backend half the chip falls back to the core `session.usage` RPC and shows only the
account the focused chat runs on.
