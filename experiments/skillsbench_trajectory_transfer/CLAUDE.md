# CLAUDE.md — experiments/skillsbench_trajectory_transfer

Work from this project directory. It is a standalone Python 3.12 uv project and must not
import another SMILE-factory project.

## Quick reference

- Setup: `uv sync --extra dev`
- Check: `make check`
- Reproduce recorded statistics: `make reproduce-analysis RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9`
- Rebuild report: `make report RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9`
- Verify artifact metadata: `make verify-artifacts RUN=exp_01ky0ztpc9eqn9g67e30pjt5k9`

Heavy training and evaluation dependencies are optional extras. CPU checks and analysis must
not import model packages or require credentials. Keep immutable run records under `runs/<EID>`;
never commit model weights, adapters, Parquet corpora, caches, or raw trajectories.
