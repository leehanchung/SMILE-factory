# eval tooling — serving, task-gen, and the BenchFlow run driver

Shared tooling for `eval/`. **BenchFlow is the sole runner**; a benchmark is a
flat `tasks/` dir under `eval/benchmarks/<name>/tasks/`, and the **agent harness**
([pi](https://github.com/badlogic/pi-mono), Claude Code, Codex, …) and **model**
are run-time knobs:

```bash
make eval BENCHMARK=simpleqa AGENT=pi     MODEL=vllm/qwen35-2b-base
make eval BENCHMARK=hotpotqa AGENT=claude MODEL=claude-haiku-4-5-20251001
```

Nothing is hard-wired to pi or a specific engine. (Default: Qwen3.5-2B-Base served
by SGLang.)

The serving engine is **SGLang** — the same inference engine [slime](https://github.com/THUDM/slime)
uses for RL rollouts, so eval and RL training share one inference stack. (vLLM is
kept as a drop-in alternative; see `serve-vllm`.)

```
 SGLang (Qwen3.5-2B-Base, OpenAI endpoint :30000)
        ▲                                   ▲  upstream
        │ pi answers, writes /app/answer.txt│
 BenchFlow sandbox (Docker) ── pi-acp ──► BenchFlow LiteLLM proxy ──┘
        │
        └─ verifier/test.sh → reward.txt  (SimpleQA: normalized match · HotpotQA: SQuAD F1)
```

## Components & why

| Piece | Choice | Notes |
|-------|--------|-------|
| Model | `Qwen/Qwen3.5-2B-Base` | `Qwen3_5ForConditionalGeneration`, Gated-DeltaNet + MoE |
| Engine | **SGLang** 0.5.23 (`:30000`) | matches slime's RL rollout engine; vLLM 0.34.0 (`:8000`) alt |
| Harness | **pi** (`pi-acp`) | a BenchFlow built-in ACP agent; talks OpenAI tool-calling |
| Runtime | **BenchFlow** | runs the agent in a sandbox, drives the verifier, aggregates rewards |
| Tasks | one dir per question | `task.md` + `verifier/` (gold answer kept out of `/app`) |

## Layout

A benchmark is just a `tasks/` dir; the run knobs (agent/model/sandbox) come from
the `make eval` driver, not from per-benchmark config.

```
eval/
  benchmarks/simpleqa/
    simple_qa_test_set.csv        optional local dataset copy (gitignored); gen fetches from the upstream URL if absent
    tasks/<id>/                   generated task dirs (gitignored): task.md + verifier/
  benchmarks/<name>/tasks/<id>/   generated task dirs (gitignored): task.md + verifier/
  _tooling/                       run everything from here
    Makefile                      the `make eval BENCHMARK/AGENT/MODEL` driver
    scripts/serve_sglang.sh       start SGLang (OpenAI endpoint :30000, tool-calling)
    scripts/serve_qwen.sh         start vLLM alternative (:8000)
    scripts/gen_tasks.py          dataset -> eval/benchmarks/<name>/tasks/
    scripts/smoke_pi.sh           agent -> engine end-to-end check (no Docker)
    scripts/install_pi_config.sh  install pi's models.json (+ engine key, 0600)
    scripts/run_local.py          DEBUG fallback: pi -> engine direct (no BenchFlow)
    pi/models.json                pi provider config (-> ~/.pi/agent/models.json)
    docs/                         investigations (e.g. the BenchFlow proxy bug)
  _runs/<agent>/<benchmark>/       BenchFlow jobs (gitignored)
```

Add a benchmark = add a generator path in `scripts/gen_tasks.py`, then
`make gen BENCHMARK=<name>` — no run.yaml, no per-benchmark config.

## One-time host setup

Already done on this machine (recorded here for reproducibility):

1. **SGLang venv** (Python 3.12, SGLang 0.5.23):
   `uv venv --python 3.12 ~/venvs/sglang-qwen && uv pip install "sglang[all]==0.5.23"`.
   (Previously 0.5.9, which `pip-audit` flags with several PYSEC advisories fixed
   in later releases; no compatibility reason pinned it. Re-check the Triton /
   CuDNN-workaround flags below after upgrading an existing venv.)
   Serve with Triton attention + PyTorch sampling (`scripts/serve_sglang.sh`) to
   avoid flashinfer's nvcc JIT — the system CUDA is 11.7, too old for the RTX 4090
   (sm_89). Use `--tool-call-parser qwen3_coder` (the model's tool-call format).
   (Optional vLLM alt: `uv pip install "vllm==0.34.0" "ninja==1.13.2"` in `~/venvs/vllm-qwen`.)
2. **pi** (needs **Node ≥ 22.19**): `npm i -g @earendil-works/pi-coding-agent@1.5.2`;
   Node via `nvm install 22` (the system Node 21 is too old — pi's `undici` needs
   `markAsUncloneable`, added in Node 22).
3. **BenchFlow** — install the **AI** project from git (the PyPI `benchflow`
   name is a different/older project):
   `uv tool install "git+https://github.com/benchflow-ai/benchflow@5a29c66b07e169437f041cc8c7501a15b03f3793"`
   (pinned to a commit — the default branch moves; bump the SHA deliberately).

All versions above are exact pins (current as of 2026-11-17; the Python pins
audit clean with `pip-audit`). Bump them deliberately, not by re-running an
unpinned install.

## Run

All commands run from `eval/_tooling/`:

```bash
# 1. Serve the model (separate terminal; first SGLang start compiles ~3 min, cached after)
make serve

# 2. Generate task dirs -> eval/benchmarks/<benchmark>/tasks/
make gen BENCHMARK=simpleqa N=50

# 3. Sanity-check agent -> engine (no Docker)
make smoke

# 4. Run a benchmark via BenchFlow — swap AGENT / MODEL freely
make eval BENCHMARK=simpleqa AGENT=pi     MODEL=vllm/qwen35-2b-base
make eval BENCHMARK=hotpotqa AGENT=claude MODEL=claude-haiku-4-5-20251001
```

`make eval` is the runner; `AGENT`/`MODEL` are the only things you change to swap
harness/model. Outputs land in `_runs/<agent>/<benchmark>/`.

> **Heads-up:** `make eval` injects `BENCHFLOW_PROVIDER_MODELS` with a `maxTokens`
> cap (`ENGINE_MAXTOK`, default 2048). Without it, benchflow's pi-acp asks SGLang for
> a 16384-token completion that overflows the 16384 context and **every call 500s**
> (resolved — see [`docs/benchflow-engine-500.md`](docs/benchflow-engine-500.md)).
> For a quick Docker-free signal, `make eval-direct BENCHMARK=<b>` runs pi → engine
> with the same tasks + scorer (**not** BenchFlow) → `_runs/_direct-debug/<benchmark>/report.json`.

A BenchFlow job lands in `_runs/<agent>/<benchmark>/<timestamp>/` — per-task
`reward.txt`/`result.json` + a job `summary.json`.

## ⚠️ Docker is required for `make eval`

BenchFlow only supports **docker / daytona / modal** sandboxes — there is no
host/local mode. This machine has no running Docker daemon (Docker Desktop is a
dangling WSL symlink and there is no passwordless sudo to install a native one),
so `make eval` is gated on **starting Docker Desktop** (with WSL integration
enabled). Once `docker info` works, it runs unchanged.

### Engine binding & API key

`serve_sglang.sh` / `serve_qwen.sh` bind **`127.0.0.1`** by default (`HOST`
overrides). That is enough for the normal flow: BenchFlow's LiteLLM proxy runs on
the host and reaches the engine over loopback; containers only talk to the proxy.

If something off-host or inside a container must reach the **engine directly**
(e.g. `host.docker.internal:30000`), start it with `HOST=0.0.0.0` **and**
`ENGINE_API_KEY=<random secret>` — the scripts refuse a non-loopback `HOST`
without a key, since an unauthenticated OpenAI endpoint is open GPU compute.
vLLM's key only guards some routes (`/invocations` serves inference without it),
so `serve_qwen.sh` also requires `ALLOW_PUBLIC_BIND=1`, confirming the port is
behind a firewall/network policy or an authenticating reverse proxy covering
every endpoint. Export the same `ENGINE_API_KEY` (and `ENGINE_HOST=<that HOST>`, which
`check-engine` probes) when running `make eval` / `make eval-direct` /
`make smoke` / `make check-engine`: the Makefile hands it to BenchFlow as the
agent's `OPENAI_API_KEY` through the environment (placeholder `dummy-key` when
unset), and `scripts/install_pi_config.sh` writes it, mode 0600, into
`~/.pi/agent/models.json` for the pi-direct paths. The key never appears in a
process's argv.

Model routing: `model: vllm/qwen35-2b-base` + `agent_env.BENCHFLOW_PROVIDER_BASE_URL`.
The run-configs point the host-side LiteLLM proxy at `http://localhost:30000/v1`
(proxy → SGLang, both on the host). BenchFlow's `vllm/` prefix just means
"self-hosted OpenAI API"; SGLang serves the same protocol.

### ✅ Resolved: BenchFlow agentic run → HTTP 500 with a self-hosted engine

Earlier, the full agentic run failed — every model call came back as `provider api
error … HTTP 500` (the engine itself returned 200). **Root cause:** benchflow's
pi-acp defaulted the model's `maxTokens` to `16384` (its `_DEFAULT_MAX_TOKENS`),
so pi requested a completion as large as the *entire* 16384 context; `prompt +
16384 > 16384`, so SGLang rejected every call with a context-length error that
litellm mislabeled as a transient HTTP 500. **Fix:** `make eval` injects
`BENCHFLOW_PROVIDER_MODELS` with `maxTokens=ENGINE_MAXTOK` (2048) so the completion
fits. (Note: BenchFlow's `vllm/` provider routes via litellm `openai/` + api_base,
**not** `hosted_vllm/`.)

Full investigation, proof, and the upstream-worthy notes:
**[`docs/benchflow-engine-500.md`](docs/benchflow-engine-500.md)**.

### Docker-Desktop-on-WSL networking patch

BenchFlow's LiteLLM proxy defaults to binding the Docker **bridge gateway IP**
(`172.17.0.1`) so the sandbox can reach it. Under Docker Desktop on WSL the engine
runs in a separate VM, so that IP is **not bindable** from this distro (the proxy
dies with `cannot assign requested address`) and the container can't reach it
either — but `host.docker.internal` works. The Makefile sets
`BENCHFLOW_DOCKER_HOST_ADDRESS=host.docker.internal`, honored by a one-line patch
to `benchflow/providers/litellm_runtime.py::_docker_host_address` (reads that env
first). Re-apply the patch after any `uv tool upgrade benchflow`. On native Linux
Docker, leave the env unset.

### Docker-free fallback (`run_local.py`)

**Not** a BenchFlow path — a debug fallback while the proxy bug stands. It reuses
the **same task dirs and the same `verifier/score.py`** but asks the model through
`pi -p --no-tools` (pi → engine directly) and scores the direct answer:

```bash
make eval-direct BENCHMARK=simpleqa N=20
make eval-direct BENCHMARK=hotpotqa N=20
```

Reference numbers (Qwen3.5-2B-Base, n=10, SGLang): SimpleQA `0.00`; HotpotQA F1
`~0.1–0.3` (noisy at n=10; 2B base). Results land in
`_runs/_direct-debug/<benchmark>/report.json`.

## Scoring

Scorers live in each task's `verifier/score.py` (self-contained, deterministic):

- **SimpleQA** — normalized match: reward 1.0 when the normalized gold answer
  equals or is contained in the agent's normalized answer. (The official SimpleQA
  metric is an LLM grader classifying CORRECT/INCORRECT/NOT_ATTEMPTED; swap in an
  `llm-judge` verifier strategy for an exact reproduction.)
- **HotpotQA** — SQuAD-style token **F1** (lowercase, strip punctuation/articles).

## Caveats

- **Base, not instruct.** Qwen3.5-2B-**Base** answers free-form chat fine, but is
  far weaker at the structured tool-calling pi uses to write `/app/answer.txt`.
  Expect low scores relative to an instruct model — that's the measurement, not a
  bug. vLLM is started with `--enable-auto-tool-choice --tool-call-parser hermes`
  so tool calls are at least accepted (without it pi gets HTTP 400 on every call).
- Task dirs and results are gitignored; regenerate with `make gen`.
```
