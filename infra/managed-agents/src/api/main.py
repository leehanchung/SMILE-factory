"""FastAPI application entry point for Claude Managed Agents API."""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, status
from fastapi.middleware.cors import CORSMiddleware

from src.api.deps import init_deps, close_deps
from src.api.routes import agents, environments, events, sessions

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage app lifecycle: startup and shutdown."""
    # Startup
    logger.info("Initializing dependencies...")
    # Connection settings come from DATABASE_URL / REDIS_URL (see deps.init_deps);
    # previously a hardcoded DSN with placeholder credentials overrode them.
    await init_deps()
    logger.info("Dependencies initialized")

    yield

    # Shutdown
    logger.info("Closing dependencies...")
    await close_deps()
    logger.info("Shutdown complete")


def create_app() -> FastAPI:
    """Create and configure the FastAPI application."""
    app = FastAPI(
        title="Claude Managed Agents API",
        description="Self-hosted clone of Claude Managed Agents on Kubernetes",
        version="0.1.0",
        lifespan=lifespan,
    )

    # ========================================================================
    # Middleware
    # ========================================================================

    # CORS middleware
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],  # TODO: Restrict to specific origins in production
        # Wildcard origins + credentials makes Starlette reflect any Origin with
        # Access-Control-Allow-Credentials, letting any site make credentialed calls.
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*", "anthropic-beta"],
    )

    # Custom middleware for anthropic-beta header validation
    @app.middleware("http")
    async def validate_anthropic_beta_header(request, call_next):
        """Validate anthropic-beta header if present."""
        # anthropic-beta header is optional but if present should be valid
        # TODO: Implement validation logic if needed
        response = await call_next(request)
        return response

    # ========================================================================
    # Routes
    # ========================================================================

    app.include_router(agents.router)
    app.include_router(environments.router)
    app.include_router(sessions.router)
    app.include_router(events.router)

    # ========================================================================
    # Health Check
    # ========================================================================

    @app.get("/health", tags=["health"])
    async def health_check():
        """Health check endpoint."""
        return {
            "status": "ok",
            "version": "0.1.0",
        }

    @app.get("/v1/health", tags=["health"])
    async def v1_health_check():
        """Health check endpoint (v1 API)."""
        return {
            "status": "ok",
            "version": "0.1.0",
        }

    # ========================================================================
    # Root
    # ========================================================================

    @app.get("/", tags=["root"])
    async def root():
        """API root endpoint."""
        return {
            "name": "Claude Managed Agents API",
            "version": "0.1.0",
            "endpoints": {
                "agents": "/v1/agents",
                "environments": "/v1/environments",
                "sessions": "/v1/sessions",
                "health": "/health",
            },
        }

    return app


# Application instance
app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "src.api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        log_level="info",
    )
