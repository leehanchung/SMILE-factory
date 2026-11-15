.PHONY: help check lora-check dr-check deploy-bot deploy-modal deploy-all

APPS := apps/delulu_discord apps/delulu_sandbox_modal
# Deep-research training+eval projects (uv-based; see docs/prd/deep-research-training-eval-infra.md)
DR_PROJECTS := libs/dr_agent services/search_server data/datagen training/rl_deepresearch

help:
	@echo "Top-level targets:"
	@echo "  make check         run ruff on all apps/"
	@echo "  make lora-check    run ruff on training/lora_instruct"
	@echo "  make dr-check      run ruff on all deep-research projects (libs/services/data/training)"
	@echo "  make deploy-bot    deploy the Discord bot to the VPS"
	@echo "  make deploy-modal  deploy the Modal sandbox app"
	@echo "  make deploy-all    modal-deploy then bot-deploy"
	@echo ""
	@echo "Sub-project targets available via:"
	@echo "  make -C apps/delulu_discord <target>"
	@echo "  make -C apps/delulu_sandbox_modal <target>"
	@echo "  make -C libs/dr_agent <target>   (and other DR_PROJECTS)"

check:
	$(MAKE) -C apps/delulu_discord check
	$(MAKE) -C apps/delulu_sandbox_modal check

lora-check:
	cd training/lora_instruct && uv run ruff check .

dr-check:
	@for p in $(DR_PROJECTS); do echo "== $$p =="; $(MAKE) -C $$p check || exit 1; done

deploy-bot:
	$(MAKE) -C apps/delulu_discord deploy

deploy-modal:
	$(MAKE) -C apps/delulu_sandbox_modal modal-deploy

deploy-all: deploy-modal deploy-bot
