"""Shared fixtures: fake DNS so no test touches the network."""

from __future__ import annotations

import socket

import pytest

from search_server import url_guard

# hostname -> list of IPs the fake resolver returns
FAKE_DNS: dict[str, list[str]] = {
    "public.example": ["93.184.216.34"],
    "public6.example": ["2606:2800:220:1:248:1893:25c8:1946"],
    "internal.example": ["10.0.0.5"],
    "loopback.example": ["127.0.0.1"],
    "metadata.example": ["169.254.169.254"],
    "mixed.example": ["93.184.216.34", "192.168.1.1"],
}


def _fake_getaddrinfo(host, port, *args, **kwargs):
    try:
        # An absolute name ("host.") resolves like the bare name here; tests
        # that need them to differ register both via `extra_dns`.
        ips = FAKE_DNS[host[:-1] if host.endswith(".") else host]
    except KeyError:
        try:  # IP literals resolve to themselves, like the real resolver
            ips = [str(url_guard.ipaddress.ip_address(host))]
        except ValueError:
            raise socket.gaierror(socket.EAI_NONAME, "not found") from None
    out = []
    for ip in ips:
        fam = socket.AF_INET6 if ":" in ip else socket.AF_INET
        sa = (ip, port, 0, 0) if fam == socket.AF_INET6 else (ip, port)
        out.append((fam, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", sa))
    return out


@pytest.fixture(autouse=True)
def fake_dns(monkeypatch):
    monkeypatch.setattr(url_guard.socket, "getaddrinfo", _fake_getaddrinfo)
    monkeypatch.delenv("SEARCH_SERVER_URL_ALLOWLIST", raising=False)
    monkeypatch.delenv("SEARCH_SERVER_TOKEN", raising=False)
