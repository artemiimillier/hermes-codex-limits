"""Codex Limits plugin backend, mounted at /api/plugins/codex-limits/.

Serves the account-limit snapshot ``hermes usage --json`` prints (same fetch, same document
schema), one document per pooled credential, so the Desktop composer chip can show how much
quota is left. Read-only: it never selects, rotates or marks a pool entry.
"""
from __future__ import annotations

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

from fastapi import APIRouter

router = APIRouter()

DEFAULT_PROVIDER = "openai-codex"
CACHE_TTL_SECONDS = 60
MAX_PARALLEL_FETCHES = 4

# provider -> (monotonic timestamp, payload). One lock doubles as single-flight: a second
# request arriving mid-fetch waits and then reads the fresh cache instead of re-fetching.
_CACHE: Dict[str, tuple] = {}
_FETCH_LOCK = threading.Lock()


def _pool_entries(provider: str) -> list:
    try:
        from agent.credential_pool import load_pool

        return list(load_pool(provider).entries())
    except Exception:
        return []


def _display_label(entry) -> Optional[str]:
    """A name that tells pool rows apart. OAuth rows are all labelled by their login flow
    (``device_code``), so prefer the account e-mail carried in the token's claims — decoded
    locally, never sent anywhere; only the e-mail string leaves this function."""
    label = str(getattr(entry, "label", "") or "").strip()
    token = getattr(entry, "access_token", None)
    if not isinstance(token, str) or not token:
        return label or None
    try:
        from agent import credential_pool

        email = credential_pool.label_from_token(token, "")
        if not email:
            profile = credential_pool._decode_jwt_claims(token).get("https://api.openai.com/profile")
            email = str(profile.get("email") or "").strip() if isinstance(profile, dict) else ""
    except Exception:
        email = ""
    if not email:
        return label or None
    return email if not label or label == getattr(entry, "source", None) or label == email else f"{label} · {email}"


def _account_document(snapshot, entry, *, index: int) -> Dict[str, Any]:
    """One account row: the stable ``hermes usage --json`` document plus pool identity."""
    doc: Dict[str, Any] = {
        "index": index,
        "id": getattr(entry, "id", None),
        "label": _display_label(entry) if entry is not None else None,
        "pool_status": getattr(entry, "last_status", None),
        "cooldown_until": getattr(entry, "last_error_reset_at", None),
    }
    if snapshot is None:
        doc.update({"available": False, "plan": None, "windows": [], "details": [],
                    "unavailable_reason": "usage could not be fetched"})
        return doc
    from hermes_cli.subcommands.usage import usage_snapshot_document

    doc.update(usage_snapshot_document(snapshot))
    doc["available"] = bool(snapshot.available)
    return doc


def _collect(provider: str) -> List[Dict[str, Any]]:
    from agent.account_usage import fetch_account_usage

    entries = _pool_entries(provider)
    if len(entries) <= 1:
        # Same credential resolution as ``hermes usage`` / a session with no live agent.
        return [_account_document(fetch_account_usage(provider), entries[0] if entries else None, index=1)]

    def fetch(entry):
        # Explicit creds pin the fetch to THIS pool entry (never re-resolved to another account).
        return fetch_account_usage(provider, base_url=entry.runtime_base_url, api_key=entry.runtime_api_key)

    with ThreadPoolExecutor(max_workers=min(MAX_PARALLEL_FETCHES, len(entries))) as pool:
        snapshots = list(pool.map(fetch, entries))
    return [_account_document(snap, entry, index=i) for i, (snap, entry) in enumerate(zip(snapshots, entries), 1)]


@router.get("/usage")
def usage(provider: Optional[str] = None, force: bool = False) -> Dict[str, Any]:
    key = (provider or DEFAULT_PROVIDER).strip().lower()
    with _FETCH_LOCK:
        cached = _CACHE.get(key)
        if cached and not force and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]
        payload = {"provider": key, "fetched_at": time.time(), "accounts": _collect(key)}
        _CACHE[key] = (time.monotonic(), payload)
        return payload
