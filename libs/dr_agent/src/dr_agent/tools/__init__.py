"""Tools — one implementation each, reused by training, eval, and serving.

Tools talk to the search/tool HTTP service (services/search_server) over a single
stable contract, so heavy retrieval deps (faiss/bm25) never enter this lib and
backends can be swapped without touching the agent loop.
"""

from dr_agent.tools.base import Tool, ToolSet, make_tool_client

__all__ = ["Tool", "ToolSet", "make_tool_client"]
