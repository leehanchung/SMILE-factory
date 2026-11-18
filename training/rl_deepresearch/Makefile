.PHONY: help sync sync-dev check lint fmt test image run

# Pinned by digest (was the floating `latest` tag, which resolved to
# nightly-dev-20261106a-cu130 on 2026-11-17). Bump tag + digest together; override with
# `make run SLIME_IMAGE=...` to try another build.
SLIME_IMAGE ?= slimerl/slime:nightly-dev-20261106a-cu130@sha256:652b94c17f968b42e133c7b0d56efb74aed596bc901614f12efba84b648598fa

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
