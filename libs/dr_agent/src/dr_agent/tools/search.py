"""Search + visit tools — clients for the services/search_server HTTP contract.

Contract (see services/search_server/server.py):
    POST /search   {"query": str, "top_k": int}  -> {"results": [...]}
    POST /visit    {"url": str}                   -> {"content": str}
"""

from __future__ import annotations

import httpx

from dr_agent.tools.base import Tool


class SearchTool(Tool):
    name = "search"
    description = "Search the corpus / web for a query; returns ranked snippets."

    async def call(self, client: httpx.AsyncClient, *, query: str, top_k: int = 10) -> str:
        resp = await client.post(f"{self.server_url}/search", json={"query": query, "top_k": top_k})
        resp.raise_for_status()
        # TODO: format results into an observation string.
        return str(resp.json().get("results", []))


class VisitTool(Tool):
    name = "visit"
    description = "Fetch and read the contents of a URL."

    async def call(self, client: httpx.AsyncClient, *, url: str) -> str:
        resp = await client.post(f"{self.server_url}/visit", json={"url": url})
        resp.raise_for_status()
        return str(resp.json().get("content", ""))
