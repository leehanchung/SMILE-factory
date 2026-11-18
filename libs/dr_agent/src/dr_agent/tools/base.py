"""Tool abstraction. Concrete tools (search, visit, scholar, python) subclass Tool.

A Tool is a thin client: it serializes args, calls the tool HTTP service, and
returns an observation string. No tool does retrieval in-process.
"""

from __future__ import annotations

import os
from abc import ABC, abstractmethod
from typing import Any

import httpx

TOKEN_ENV = "SEARCH_SERVER_TOKEN"


def make_tool_client(token: str | None = None, **kwargs: Any) -> httpx.AsyncClient:
    """Build the AsyncClient tools are called with.

    Sends ``Authorization: Bearer <token>`` when a token is given or
    ``SEARCH_SERVER_TOKEN`` is set, matching services/search_server's optional
    auth. Extra kwargs go to ``httpx.AsyncClient``.
    """
    token = token if token is not None else os.environ.get(TOKEN_ENV)
    headers = dict(kwargs.pop("headers", None) or {})
    if token:
        headers["Authorization"] = f"Bearer {token}"
    kwargs.setdefault("timeout", 30.0)
    return httpx.AsyncClient(headers=headers, **kwargs)


class Tool(ABC):
    """Base class for an agent tool."""

    name: str
    description: str

    def __init__(self, server_url: str) -> None:
        self.server_url = server_url.rstrip("/")

    @abstractmethod
    async def call(self, client: httpx.AsyncClient, **kwargs) -> str:
        """Invoke the tool and return an observation string for the agent."""
        ...


class ToolSet:
    """A named collection of tools an agent may use."""

    def __init__(self, tools: list[Tool]) -> None:
        self._tools = {t.name: t for t in tools}

    def get(self, name: str) -> Tool:
        return self._tools[name]

    def names(self) -> list[str]:
        return list(self._tools)
