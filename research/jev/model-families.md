# Autoregressive, looped, and diffusion language models

These terms describe different axes. A Transformer is an architecture; autoregression and diffusion describe how a model learns and generates sequences. Looped transformers reuse computation across depth and can still generate autoregressively. All three can be large language models. This comparison synthesizes the sources below.

| Approach | Main operation | What advances on each step |
| --- | --- | --- |
| Conventional autoregressive transformer | Process the available prefix through a fixed stack of layers and predict the next token | The generated sequence grows by a token |
| Looped transformer | Repeatedly apply a shared transformer block to evolving hidden states | Internal representations change before a token prediction |
| Diffusion language model | Learn to reverse corruption, such as masking, and iteratively reconstruct a sequence | A partially masked or noisy sequence becomes more complete |

Conventional autoregressive generation produces tokens sequentially, while prompt processing can be parallel. Previously computed attention keys and values can be cached. See [Clippings/Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/).

Looping reuses weights, not identical inputs: each iteration receives an updated hidden state. It increases effective depth without adding a fresh set of parameters for every iteration. Recurrent-depth models can allocate additional inference compute without expressing every intermediate step as text; extra iterations still cost computation, and improved accuracy is not guaranteed indefinitely. See [Geiping et al.](https://arxiv.org/abs/2502.05171).

Masked diffusion models such as LLaDA train by masking tokens and predicting the missing content. Generation starts with masked output positions and fills them over multiple denoising steps, potentially predicting multiple positions together with context on both sides. The number of denoising steps and the sampling schedule affect speed and quality; parallel token prediction alone does not guarantee lower latency. Masked diffusion is one form of language diffusion, not the definition of the entire family. See [Nie et al.](https://arxiv.org/abs/2502.09992).

An illustrative generation trace, treating words as tokens for simplicity:

```text
Autoregressive: The -> The cat -> The cat sat
Looped AR:     hidden state -> shared block -> shared block -> next token
Diffusion:     [MASK] [MASK] [MASK] -> The [MASK] sat -> The cat sat
```

The loop in a looped transformer refines hidden representations. The loop in diffusion performs denoising of a candidate sequence. Their repeated computation serves different purposes; a hybrid is conceptually possible because the choices concern different axes.

## Sources

- [Clippings/Transformer Inference Arithmetic](https://kipp.ly/transformer-inference-arithmetic/)
- [Scaling up Test-Time Compute with Latent Reasoning: A Recurrent Depth Approach](https://arxiv.org/abs/2502.05171)
- [Large Language Diffusion Models](https://arxiv.org/abs/2502.09992)
