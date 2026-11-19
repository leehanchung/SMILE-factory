.PHONY: help sync sync-dev check lint fmt test image run

# Pinned by digest to the newest stable release, v0.4.0 (CUDA 13.0 build, 2026-10-09).
# Previously the floating `latest` tag (a nightly). Bump tag + digest together; override with
# `make run SLIME_IMAGE=...` to try another build.
SLIME_IMAGE ?= slimerl/slime:v0.4.0-cu130@sha256:18a84672ca67ddcf611528399c2cda2c2520b52c31c82256597c056af4ee6411

help:
	@echo "Targets:"
	@echo "  make sync       uv sync runtime deps (light; engine is the container)"
	@echo "  make check      ruff check + format --check"
	@echo "  make lint       ruff check --fix"
	@echo "  make test       pytest"
	@echo "  make image      docker pull the slime engine image"
	@echo "  make run        launch a run inside the slime container (see engine/README.md)"

sync:
	uv sync

sync-dev:
	uv sync --extra dev

check: sync-dev
	uv run ruff check .
	uv run ruff format --check .

lint: sync-dev
	uv run ruff check --fix .

fmt: sync-dev
	uv run ruff format .

test: sync-dev
	uv run pytest

image:
	docker pull $(SLIME_IMAGE)

run:
	docker run --rm --gpus all --ipc=host --shm-size=16g \
	  --ulimit memlock=-1 --ulimit stack=67108864 \
	  -v "$(CURDIR)":/workspace -w /workspace \
	  $(SLIME_IMAGE) bash launch/run.sh
