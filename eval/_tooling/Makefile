# eval driver — BenchFlow is the sole runner; --agent and --model are the knobs.
#
# A benchmark = eval/benchmarks/<name>/tasks/ (a flat dir of BenchFlow task dirs).
# Run any benchmark with any agent/model:
#
#   make eval BENCHMARK=simpleqa AGENT=pi     MODEL=vllm/qwen35-2b-base
#   make eval BENCHMARK=hotpotqa AGENT=claude MODEL=claude-haiku-4-5-20251001
#   make eval BENCHMARK=simpleqa AGENT=codex  MODEL=gpt-5.4
#
# Run all `make` commands from eval/_tooling/.

# NOTE: never put an inline `# comment` after a `VAR := value` — Make folds the
# trailing spaces into the value (silently breaks URLs/paths). Comments go above.
SHELL := /bin/bash

# eval/ root, relative to eval/_tooling/
EVAL := ..

# ---- run knobs (override on the CLI) ----
BENCHMARK ?= simpleqa
AGENT ?= pi
MODEL ?= vllm/qwen35-2b-base
SANDBOX ?= docker
CONCURRENCY ?= 5
# N: tasks to generate (gen target)
N ?= 50
# ENGINE_PORT: local engine — SGLang 30000, vLLM 8000
ENGINE_PORT ?= 30000
ENGINE_URL ?= http://localhost:$(ENGINE_PORT)/v1
# ENGINE_API_KEY: bearer key the engine requires. Optional for the default
# loopback-only engine; REQUIRED when the engine binds a non-loopback HOST (e.g.
# HOST=0.0.0.0 so task containers can reach it via host.docker.internal). Exported
# so recipes read it from the environment; it is never put on a command line.
# Unset -> placeholder "dummy-key".
ENGINE_API_KEY ?=
export ENGINE_API_KEY
# ENGINE_HOST: where check-engine probes the engine; set it to the HOST the serve
# script was started with (e.g. ENGINE_HOST=::1). Wildcard binds map to loopback
# (0.0.0.0 -> 127.0.0.1, :: -> ::1) and IPv6 literals get bracketed. A separate
# knob because some shells export HOST as the machine's hostname.
ENGINE_HOST ?= 127.0.0.1
# Token budget for the self-hosted model. CRITICAL: without an explicit maxTokens,
# benchflow's pi-acp registers the model with maxTokens = its own _DEFAULT_MAX_TOKENS
# (16384) and pi then asks SGLang for a completion that large — prompt+completion
# overflows the 16384 context, so SGLang rejects EVERY call and litellm mislabels it
# a transient HTTP 500 (errored=all). Cap the completion well under ENGINE_CONTEXT so
# input+output fits. See docs/benchflow-engine-500.md.
ENGINE_CONTEXT ?= 16384
ENGINE_MAXTOK ?= 2048
# bare model id (strip the vllm/ provider prefix) for pi's model-registry entry
MODEL_ID := $(patsubst vllm/%,%,$(MODEL))
# compact JSON (NO spaces — single-quoted in the recipe so bash doesn't brace-expand it)
ENGINE_MODELS := [{"id":"$(MODEL_ID)","name":"$(MODEL_ID)","contextWindow":$(ENGINE_CONTEXT),"maxTokens":$(ENGINE_MAXTOK),"reasoning":false,"input":["text"]}]

# Self-hosted models (BenchFlow's `vllm/` provider = any local OpenAI endpoint)
# need the engine URL injected + the engine key (ENGINE_API_KEY, else a placeholder) + a model entry that caps
# maxTokens (above), and a reachable engine. First-party agents/models
# (claude/codex/…) bring their own auth + metadata, so skip all of it.
ifneq ($(findstring vllm/,$(MODEL)),)
  ENGINE_ENV := --agent-env BENCHFLOW_PROVIDER_BASE_URL=$(ENGINE_URL) --agent-env 'BENCHFLOW_PROVIDER_MODELS=$(ENGINE_MODELS)'
  # The key reaches bench through its environment, not argv: for the vllm/
  # provider BenchFlow inherits OPENAI_API_KEY from os.environ
  # (benchflow/agents/env.py auto_inherit_env). A .env here would take precedence.
  ENGINE_KEY_ENV := OPENAI_API_KEY="$${ENGINE_API_KEY:-dummy-key}"
  ENGINE_DEP := check-engine
else
  ENGINE_ENV :=
  ENGINE_KEY_ENV :=
  ENGINE_DEP :=
endif

# Docker-Desktop-on-WSL: force host.docker.internal for the proxy (see docs/).
export BENCHFLOW_DOCKER_HOST_ADDRESS ?= host.docker.internal

.PHONY: eval eval-direct serve serve-vllm gen gen-all smoke check-engine clean help

help:
	@echo "Run from eval/_tooling/:"
	@echo "  make serve                       start the engine (SGLang :30000)"
	@echo "  make gen BENCHMARK=simpleqa N=50 generate task dirs -> benchmarks/<B>/tasks/"
	@echo "  make eval BENCHMARK=.. AGENT=.. MODEL=..   run a benchmark via BenchFlow"
	@echo "  make smoke                       sanity-check agent->engine (no Docker)"
	@echo "Knobs: BENCHMARK AGENT MODEL SANDBOX CONCURRENCY  (see top of Makefile)"

# THE eval command: BenchFlow runs benchmarks/<BENCHMARK>/tasks with the chosen agent+model.
eval: $(ENGINE_DEP)
	$(ENGINE_KEY_ENV) bench eval run \
	  --tasks-dir $(EVAL)/benchmarks/$(BENCHMARK)/tasks \
	  --agent $(AGENT) --model $(MODEL) \
	  --sandbox $(SANDBOX) --concurrency $(CONCURRENCY) \
	  --jobs-dir $(EVAL)/_runs/$(AGENT)/$(BENCHMARK) \
	  $(ENGINE_ENV)

serve:
	bash scripts/serve_sglang.sh

serve-vllm:
	bash scripts/serve_qwen.sh

gen:
	uv run --with 'datasets==5.2.0' python scripts/gen_tasks.py --benchmark $(BENCHMARK) --n $(N)

gen-all:
	$(MAKE) gen BENCHMARK=simpleqa N=$(N)
	$(MAKE) gen BENCHMARK=hotpotqa N=$(N)

smoke: check-engine
	bash scripts/smoke_pi.sh

# The key reaches curl on stdin (-H @-), never in its argv.
check-engine:
	@h='$(ENGINE_HOST)'; case "$$h" in ""|0.0.0.0) h=127.0.0.1 ;; "::") h=::1 ;; esac; \
	[[ $$h == *:* ]] && h="[$$h]"; \
	url="http://$$h:$(ENGINE_PORT)/v1/models"; \
	if [[ -n "$${ENGINE_API_KEY:-}" ]]; then \
	  printf 'Authorization: Bearer %s\n' "$$ENGINE_API_KEY" | curl -sf -m 10 -H @- "$$url" >/dev/null; \
	else \
	  curl -sf -m 10 "$$url" >/dev/null; \
	fi \
	  && echo "engine up at $$h:$(ENGINE_PORT)" \
	  || (echo "engine NOT reachable at $$h:$(ENGINE_PORT) — run 'make serve' first" && exit 1)

# Docker-free DEBUG fallback (NOT BenchFlow): pi -> engine direct, same tasks+scorer.
# For sanity-checking the model while the BenchFlow proxy bug is open
# (docs/benchflow-engine-500.md). Not the official path.
eval-direct: check-engine
	bash scripts/install_pi_config.sh
	python3 scripts/run_local.py --benchmark $(BENCHMARK) --n $(N)

clean:
	rm -rf $(EVAL)/benchmarks/*/tasks $(EVAL)/_runs
