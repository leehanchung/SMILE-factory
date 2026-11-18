# Bradley–Terry example

The [bundled PNG](../assets/bradley-terry-example.png) is an original generated infographic created on 2026-10-15. It shows one illustrative preference pair moving through scores, a probability, and a loss. Use it as a visual reference; preserve the general teaching style while adapting content and layout to the requested concept.

## Content source

Rafailov et al., *Direct Preference Optimization: Your Language Model is Secretly a Reward Model*, [arXiv:2305.18290v3, Section 3, equations 1–2](https://arxiv.org/html/2305.18290v3#S3), supplies the reward-model probability and objective. This example illustrates that reward-model loss, not the later DPO policy objective.

The caching answers, the preference for A, and the scores are invented teaching inputs rather than reported data. With log-strength scores `s_A = 2` and `s_B = 1`:

```tex
\Delta = s_A-s_B = 1
p = P(A \succ B) = \frac{1}{1+e^{-\Delta}} \approx 0.731
\ell = -\ln p = \ln(1+e^{-\Delta}) \approx 0.313\ \text{nats}
```

The exact calculated values are `p = 0.7310585786300049` and `loss = 0.31326168751822286`. A is the observed preferred answer throughout. The other answer's modeled probability is about 26.9%.

## Rendering and verification

The image was generated with a native image tool, then corrected once. The first render had correct numeric labels but a misleading probability-bar split, so the final render uses two labeled value cards. The source equations and calculations were independently checked; the final image was visually inspected for signs, exponents, subscripts, labels, preference identity, scope, and citation.

The PNG is 1122 × 1402 pixels. No editable vector or typeset source is bundled. Small-screen legibility was not separately tested. The source footer is small, and the final probability card uses a circular B badge where earlier panels use a square; explicit labels and colors preserve identity. Treat these as limits of the example, not design requirements to repeat.

This is one rendered mathematical example, not a success-rate measurement or evidence that every topic will reproduce equally well. The original third-party style image is not included.

## Accessible description

Four numbered panels follow an illustrative prompt asking to explain caching. An observed label prefers answer A over B. A reward model assigns scores of 2 and 1; their difference is 1. A sigmoid maps that difference to a modeled preference probability of about 0.731. The negative natural logarithm of the observed preference's probability gives a loss of about 0.313 nats. The takeaway states that a larger gap in the preferred answer's favor lowers this pair's loss, while training averages loss over labeled pairs.
