# engine/ — slime is NOT vendored here

slime (THUDM/slime) is the RL engine and is consumed as a **Docker image**
(`slimerl/slime:latest`), not a git submodule or a vendored fork. The image
already bakes in the patched Megatron-LM and SGLang that slime requires, so a
bare-metal install is not worth attempting.

This directory is intentionally (almost) empty. The integration surface is:

1. **Pull the image** (pin a digest for reproducibility):
   ```bash
   docker pull slimerl/slime:latest
   ```
2. **Run the container** with this recipe mounted and GPUs attached:
   ```bash
   docker run --rm --gpus all --ipc=host --shm-size=16g \
     --ulimit memlock=-1 --ulimit stack=67108864 \
     -v "$(git rev-parse --show-toplevel)":/repo -w /repo/training/rl_deepresearch \
     -it slimerl/slime:latest bash
   ```
   (Mount the **repo root**, not just this recipe dir — the shared `libs/dr_agent`
   lives outside the recipe and must be reachable inside the container.)
3. **Inside the container**, install our shared lib + this recipe, then launch:
   ```bash
   pip install -e /repo/libs/dr_agent --no-deps
   bash launch/run.sh
   ```

Our only code is in `../plugins/` (the rollout + reward functions), wired into
slime purely by CLI flag — `--custom-generate-function-path` and
`--custom-rm-path`. We never patch slime core.

If we ever need to pin a digest or bake plugins into an image, add a thin
`Dockerfile` here (`FROM slimerl/slime@sha256:...` + `COPY`), but prefer the
bind-mount workflow above for development.
