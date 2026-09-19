# Monte Carlo calibration study

Proposed 2026-09-19; no simulations or model evaluations have run. Companion to the [GLiNER2 benchmark](gliner2-benchmark.md). Use known data-generating distributions to separate probability elicitation, calibration-method behavior, and sampling noise. Synthetic success is not evidence of deployment calibration.

## Motivation and source example

In the [post supplied by Han](https://www.linkedin.com/feed/update/urn:li:activity:7506796921362030593/), John Berryman reports that Jev assigned approximately 99% to heads when the context explicitly stated a 60% heads probability. He describes a probability sweep in which Choice favored the most likely outcome too strongly, while Noul tracked the underlying probability more closely but remained biased. This is an author-reported result, read in the browser, not a reproduction or a finding about GLiNER2.

A TypeSafe reply links to [Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): the vendor documents numerical weaknesses and discrepancies between Choice and Noul. Record exact model versions rather than relying on `jev-latest`. We will evaluate whether outputs can serve as event probabilities under our benchmark contract; vendor interface differences must remain explicit.

The first diagnostic is probability preservation: given a known event probability, does the model return that probability or merely identify the more likely outcome? Repeated random outcomes then test empirical reliability and the calibration procedure's sampling behavior. Follow the aims, data-generating mechanisms, estimands, methods, and performance-measures structure in [Morris, White, and Crowther](https://arxiv.org/abs/1712.03198), including Monte Carlo standard errors.

## Two complementary experiments

**A. Model probability elicitation.** Render known distributions as text, obtain complete GLiNER2 classification scores using the benchmark adapter, and compare with analytic event probabilities. Compare choice and boolean formulations, with matching event semantics. Add Jev Choice/Noul, GLiClass, and Nimble where available, reporting each interface separately. A GLiNER2 true/false classification is an adaptation, not a native Noul interface.

**B. Calibration-method simulation.** Generate scores with known distortions of the true probabilities, fit post-hoc calibrators, and evaluate on independently generated outcomes. This isolates calibrator behavior without repeated model inference. Include cached real-model scores from A as a separate score source. Neither repeated deterministic calls nor random label draws constitute Monte Carlo dropout or a Bayesian posterior over model weights.

## Distribution and event matrix

For continuous distributions, ask about threshold events or exhaustive disjoint bins. This tests categorical/boolean probabilities and does not add unrestricted numerical forecasting to GLiNER2's claimed capabilities. State units, parameter conventions, independence assumptions, and bin boundaries in every rendered task.

| Generator | Proposed parameter cases | Event or choices; oracle |
| --- | --- | --- |
| Bernoulli | `p = 0, .01, .05, .1, .2, .4, .49, .5, .51, .6, .8, .9, .95, .99, 1` | Heads/tails; `P(heads)=p` |
| Categorical / loaded die | Uniform, one dominant outcome, two near-tied outcomes; `K=2,3,6,10` | One outcome per label; complete supplied probability vector |
| Binomial | `n=5,20,100`, `p=.1,.5,.9` | At least `k` successes; exact survival probability |
| Poisson | Rates `.5,2,10` per stated interval | At least `k` arrivals; exact survival probability |
| Uniform | `U(0,1)` and `U(0,100)` | `X <= t`; clipped linear CDF |
| Normal | Means `0,10`, standard deviations `1,5` | `X <= mu + c*sigma`, `c=-2,-1,0,1,2`; normal CDF |
| Exponential | Rates `.2,1,5` in inverse time units | Wait exceeds `t`; `exp(-rate*t)` |
| Lognormal | Log-location `0`, log-scale `.5,1.5` | Threshold/tail events; lognormal CDF |
| Student-t | Degrees of freedom `3,5,30`, location `0`, scale `1` | Threshold/tail events; t CDF; scale is not standard deviation |
| Two-component normal mixture | `.5*N(-2,1) + .5*N(2,1)`; weights `.9/.1` sensitivity | Tail or interval events; weighted component CDFs; component variance is `1` |
| Beta–Bernoulli predictive | Known prior `(alpha,beta)=(1,1),(.5,.5),(2,8)` and observed counts | Next success after `s` successes in `n` trials; `(alpha+s)/(alpha+beta+n)` |

Choose count thresholds and continuous bins on development grids to include rare, central, and near-certain events. For infinite-support distributions include an overflow/tail bin. Generate one underlying outcome per context and derive all related event labels from it, preserving logical dependence. For the Beta–Bernoulli case sample the next outcome from the posterior predictive; do not score against an unobserved latent coin bias as if the model knew it.

Cross each family with three prompt tracks:

1. **Explicit event probability:** provide the precomputed probability in the context. Minimal arithmetic; isolates preservation and elicitation.
2. **Distribution parameters:** provide the generating parameters only. Measures numerical reasoning plus probability elicitation; failures cannot be attributed solely to calibration.
3. **Observed sample:** provide observations and a stated inference model/prior. Begin with the conjugate Beta–Bernoulli case, whose predictive answer is known. Do not invent a unique oracle from finite observations without an inference assumption.

Compare decimal, percentage, and frequency wording, candidate permutation, event complementation, and single-question versus packed requests. Include a separate “which outcome is most likely?” control with a categorical correct-answer target. Confidence in that answer is not the probability of the next random outcome. Keep all variants of a scenario together across splits; hold out wording templates and parameter ranges for transfer evaluation.

## Simulation of probability populations and miscalibration

For binary method experiments, draw latent event probabilities `q`, then `Y | q ~ Bernoulli(q)`. Vary the population of `q` independently from the outcome family above:

- `Beta(1,1)` for broad coverage; `Beta(5,5)` for ambiguous cases.
- `Beta(.3,.3)` for extreme probabilities; `Beta(1,19)` and its mirror for rare/common events.
- A 50/50 mixture of `Beta(2,18)` and `Beta(18,2)` for two populations.
- `sigmoid(Z)`, with `Z ~ Normal(0,1)` or `2*t_3`, for alternative logit shapes.

Use these score mechanisms, with parameters fixed in the scenario manifest:

| Mechanism | Reported raw probability `p` | Purpose |
| --- | --- | --- |
| Calibrated oracle | `p=q` | Calibrators should not systematically improve the population oracle |
| Over/underconfidence | `p=sigmoid(a*logit(q))`, `a=2,.5` | Temperature-like distortion |
| Intercept bias | `p=sigmoid(logit(q)+b)`, `b=-1,+1` | Distortion requiring an intercept |
| Nonlinear monotone | `p=q^2` or `sqrt(q)` | Test limits of simple parametric corrections |
| Winner collapse | `.99` if `q>.5`, `.01` if `q<.5`, `.5` at a tie | Information lost by collapsing distinct probabilities |
| Group-dependent bias | `p=sigmoid(logit(q)+b_g)`, `b_g=-1,+1` | Compare pooled correction with observed-group correction |

Keep exact endpoint cases in a separate panel. Use stable arithmetic and a documented numerical epsilon only where logs demand it; report saturated predictions and sensitivity to clipping. Never call clipping a calibration improvement.

For multiclass studies, draw `q ~ Dirichlet(c*pi)` with `c=.3,3,30`, uniform or skewed class means `pi`, and `K=2,3,6,10`. Draw `Y ~ Categorical(q)` and distort with `p=softmax(a*log(q)+b)` using `a=.5,1,2` and a prespecified class-bias vector. Keep probability vectors and argmax choices separate. Compare raw, scalar temperature, and the existing family-correction arms; binary logistic/isotonic methods apply to binary tracks, not unnormalized multiclass outputs.

## Repetitions, fitting, and shift

Start with a screening design rather than crossing every factor: binary probability-population × distortion × calibration-budget cells, followed by targeted multiclass, subgroup, and shift studies. Use budgets `100,250,500,1000,2000` independent calibration contexts and 100 pilot repetitions per cell. Predeclare 1,000 repetitions for confirmatory cells selected using development simulations, with 10,000 independent test draws per repetition. Use separate random streams for generation, outcomes, fitting, and evaluation; pair methods on the same draws. Store seeds and fit failures, including single-class samples.

Fit the raw/temperature/logistic/isotonic and family methods defined in the [benchmark](gliner2-benchmark.md#phase-2-controlled-experiment-matrix), subject to their task semantics. Select complexity on independent simulation-development runs. Every repetition draws fresh calibration and test samples. For cached model scores, bootstrap independent scenario groups; resampling outcomes for a fixed prompt is conditional repeated-trial evidence, not additional independent prompts.

Test three shifts separately: change the distribution of `q` while preserving the outcome and scoring mechanisms; change subgroup mixture weights; change the score–outcome relationship itself. A calibrator fitted to the old population remains frozen. Include a separate recalibration arm with fresh labeled target-population data and count that label cost. Report interpolation versus held-out parameter ranges and entire unseen distribution families separately.

## Measures, checks, and deliverables

- **Known-probability recovery:** MAE/RMSE of predicted probabilities versus `q`, maximum error, and curves of predicted versus oracle probability. For choice vectors add total variation distance. Report frequency of near-0/1 predictions on genuinely uncertain events.
- **Expected proper scores:** compute expected binary log loss `-q*log(p)-(1-q)*log(1-p)` and expected Brier `(p-q)^2+q*(1-q)`. Also score sampled outcomes. This separates probability error from irreducible outcome noise and verifies the Monte Carlo implementation. Use analogous categorical expectations.
- **Reliability:** retain observed reliability diagrams/ECE, but compare bin mean prediction with bin mean oracle probability as well. `E[(p-q)^2]` measures oracle recovery, not pure calibration: a coarse forecast can be calibrated yet uninformative. In winner-collapse cells compare against `E[q | raw score]`, the best correction available from that score alone, as well as the full-information oracle.
- **Coherence:** test complement sums, nested-event monotonicity, and agreement between choice and boolean event formulations before and after calibration. These are separate requirements; marginal calibration alone does not enforce them.
- **Finite-sample performance:** report mean/SD of paired improvements, failure rate, worst-group reliability, risk–coverage behavior, and Monte Carlo standard errors. For a mean use `SD across repetitions / sqrt(R)`; for an estimated coverage rate use `sqrt(coverage*(1-coverage)/R)`. At `R=1000`, estimated 95% coverage has Monte Carlo SE about 0.007.
- **Interval validation:** on selected cells, test whether the benchmark's bootstrap intervals cover the corresponding known or high-precision population estimand at their nominal rate. Keep inner bootstrap resamples distinct from outer simulation repetitions. Use exact binomial intervals for independent event-frequency checks, including zero observed errors.

Before scaling, verify generator support, probability sums, tail-bin completeness, complements, the `p=q` control, and agreement between analytic and simulated event frequencies within sampling uncertainty. Use a probability-parser/calculator baseline on explicit-probability tasks and a CDF baseline on parameter tasks to catch prompt/oracle bugs.

Deliver a scenario manifest, per-repetition metrics, recovery curves, reliability plots, distribution-by-method heatmaps, and calibration-budget curves with Monte Carlo uncertainty. Keep distribution-family failures visible; do not reduce this diagnostic to a single aggregate leaderboard. Passing this study supports claims about the tested probability tasks and calibration procedures; the real-domain held-out benchmark remains required.
