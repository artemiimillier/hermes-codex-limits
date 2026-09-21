# codex-limits — Hermes plugin

Shows how much of the Codex (ChatGPT plan) quota is left, right before the model picker in the
Hermes Desktop composer. Click the chip for every rate-limit window, reset times, and — when the
backend half is installed — one row per account in the `openai-codex` credential pool.

## Parts

| Part | Where it runs | Path |
| --- | --- | --- |
| Backend route `GET /api/plugins/codex-limits/usage` | the Hermes backend that owns the credentials | `dashboard/plugin_api.py` |
| Desktop chip | Hermes Desktop (renderer) | `desktop-standalone/plugin.js` |

The backend route reuses the fetch behind `hermes usage --json` and calls it once per pooled
credential. It is read-only: it never selects, rotates or marks a pool entry, and tokens never
leave the backend — the response carries only plan, window percentages, reset times and the
account e-mail used as a row label.

## Install

Backend (on the machine that runs `hermes serve` / the gateway):

```bash
hermes plugins install artemiimillier/hermes-codex-limits --enable
```

then restart the backend — plugin API routes are mounted at startup only.

Desktop: copy `desktop-standalone/plugin.js` to `~/.hermes/desktop-plugins/codex-limits/plugin.js`
on the computer running Hermes Desktop. It hot-loads; no rebuild. (It is deliberately not shipped
as `desktop/plugin.js`: a package's desktop half is opt-in, the standalone root is on by default.)

Without the backend half the chip falls back to the core `session.usage` RPC and shows only the
account the focused chat runs on.
