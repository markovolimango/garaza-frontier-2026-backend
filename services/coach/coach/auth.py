"""Authentication: operator API token, pairing codes, device tokens, short-lived stream tickets.

- Secrets are random (secrets module); only SHA-256 hashes of device tokens and tickets are kept.
- Tokens are accepted from the Authorization header or an auth message on the socket, never
  from query strings, and are never logged.
- The operator token comes from COACH_API_TOKEN or is generated per run and written to
  <runtime_dir>/api_token with 0600 permissions (the path, not the token, is printed).
"""

from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import time
from dataclasses import dataclass, field
from pathlib import Path


def _hash(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


@dataclass
class Principal:
    role: str                      # "operator" | "device" | "ticket"
    device_id: str | None = None
    device_kind: str | None = None  # iphone | mac | simulator
    name: str | None = None

    @property
    def is_operator(self) -> bool:
        return self.role == "operator"


@dataclass
class _Device:
    device_id: str
    kind: str
    name: str | None
    expires_at: float


@dataclass
class _Expiring:
    expires_at: float
    used: bool = False


@dataclass
class AuthStore:
    runtime_dir: Path
    configured_token: str | None = None
    pairing_ttl_s: float = 300.0
    device_ttl_s: float = 24 * 3600
    ticket_ttl_s: float = 30.0
    clock: callable = time.time
    _api_token_hash: str = field(init=False, default="")
    _pairing: dict[str, _Expiring] = field(init=False, default_factory=dict)
    _devices: dict[str, _Device] = field(init=False, default_factory=dict)
    _tickets: dict[str, _Expiring] = field(init=False, default_factory=dict)
    _failures: list[float] = field(init=False, default_factory=list)
    token_file: Path | None = field(init=False, default=None)

    def __post_init__(self) -> None:
        token = self.configured_token
        if not token:
            token = secrets.token_urlsafe(32)
            self.runtime_dir.mkdir(parents=True, exist_ok=True)
            self.token_file = self.runtime_dir / "api_token"
            fd = os.open(self.token_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(token + "\n")
            os.chmod(self.token_file, 0o600)
        self._api_token_hash = _hash(token)

    # ---------------------------------------------------------------- authentication
    def authenticate(self, token: str | None) -> Principal | None:
        if not token or len(token) > 512:
            return None
        hashed = _hash(token)
        if hmac.compare_digest(hashed, self._api_token_hash):
            return Principal(role="operator")
        device = self._devices.get(hashed)
        if device and device.expires_at > self.clock():
            return Principal(role="device", device_id=device.device_id, device_kind=device.kind, name=device.name)
        return None

    # ---------------------------------------------------------------- pairing
    def create_pairing_code(self) -> tuple[str, float]:
        self._expire()
        code = f"{secrets.randbelow(10**8):08d}"
        expires = self.clock() + self.pairing_ttl_s
        self._pairing[_hash(code)] = _Expiring(expires)
        return code, expires

    def pairing_locked(self) -> bool:
        now = self.clock()
        self._failures = [t for t in self._failures if now - t < 300]
        return len(self._failures) >= 10

    def pair(self, code: str, device_id: str, kind: str, name: str | None) -> tuple[str, float] | None:
        """Exchange a single-use pairing code for a device token."""
        self._expire()
        if self.pairing_locked():
            return None
        entry = self._pairing.get(_hash(code.replace("-", "").strip()))
        if entry is None or entry.used or entry.expires_at <= self.clock():
            self._failures.append(self.clock())
            return None
        entry.used = True
        token = secrets.token_urlsafe(32)
        expires = self.clock() + self.device_ttl_s
        # One active token per device id: re-pairing replaces the old token.
        self._devices = {h: d for h, d in self._devices.items() if d.device_id != device_id}
        self._devices[_hash(token)] = _Device(device_id, kind, name, expires)
        return token, expires

    def revoke_device(self, device_id: str) -> int:
        before = len(self._devices)
        self._devices = {h: d for h, d in self._devices.items() if d.device_id != device_id}
        return before - len(self._devices)

    def paired_devices(self) -> list[dict]:
        self._expire()
        return [{"device_id": d.device_id, "kind": d.kind, "name": d.name, "expires_at": d.expires_at}
                for d in self._devices.values()]

    # ---------------------------------------------------------------- stream tickets
    def create_ticket(self) -> tuple[str, float]:
        self._expire()
        ticket = secrets.token_urlsafe(24)
        expires = self.clock() + self.ticket_ttl_s
        self._tickets[_hash(ticket)] = _Expiring(expires)
        return ticket, expires

    def redeem_ticket(self, ticket: str | None) -> bool:
        if not ticket or len(ticket) > 256:
            return False
        entry = self._tickets.pop(_hash(ticket), None)  # single use
        return bool(entry and entry.expires_at > self.clock())

    def _expire(self) -> None:
        now = self.clock()
        self._pairing = {k: v for k, v in self._pairing.items() if v.expires_at > now and not v.used}
        self._tickets = {k: v for k, v in self._tickets.items() if v.expires_at > now}
        self._devices = {k: v for k, v in self._devices.items() if v.expires_at > now}


def origin_allowed(origin: str | None, allowed: list[str]) -> bool:
    """Native clients send no Origin header. Browser origins must be listed exactly."""
    if origin is None:
        return True
    return origin in allowed


def bearer_token(header_value: str | None) -> str | None:
    if not header_value:
        return None
    scheme, _, token = header_value.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None
    return token.strip()
