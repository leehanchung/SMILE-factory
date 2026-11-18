# Inference

## Local serving

`deploy_local.sh` starts vLLM's OpenAI-compatible server. It binds to
`127.0.0.1` by default (`HOST`/`PORT`/`MODEL` env vars override). Set
`VLLM_API_KEY` to require a bearer token (vLLM reads it from the environment,
so it stays out of the process arguments).

vLLM's API key only guards some routes; others, such as `/invocations`, serve
inference without it. To bind a non-loopback `HOST`, put an authenticating
reverse proxy or a network policy that allowlists clients in front of the
server, then opt in with `ALLOW_PUBLIC_BIND=1` (a `VLLM_API_KEY` is still
required):

```bash
ALLOW_PUBLIC_BIND=1 VLLM_API_KEY=... HOST=0.0.0.0 ./deploy_local.sh
OPENAI_API_KEY=$VLLM_API_KEY uv run python bench.py \
    --api-url http://localhost:8000/v1/chat/completions --model <model>
```

## Benchmarking Online LLM API Services
There's no obvious standards in benchmarking LLM API Services, where inference optimization packages mostly focuses on benchmarking model serving workers instead of the end to end model serving services. This benchmark aims to benchmark LLM APIs from an user's perspective for capacity planning and scaling needs.


## References
- [Anyscale: Reproducible Performance Metrics for LLM inference](https://www.anyscale.com/blog/reproducible-performance-metrics-for-llm-inference)
- [Anyscale: LLMPerf](https://github.com/ray-project/llmperf)
- [Anyscale: Continuous Batching](https://github.com/anyscale/llm-continuous-batching-benchmarks/blob/master/benchmark_throughput.py)
- [FastChat: Test Throughput](https://github.com/lm-sys/FastChat/blob/5dbc4f30ab36f17b8e004246e53f1e13fce4a01c/fastchat/serve/test_throughput.py)
- [vLLM: Benchmark Serving](https://github.com/vllm-project/vllm/blob/main/benchmarks/benchmark_serving.py)
