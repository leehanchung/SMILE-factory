PYTHON ?= python3
NODE ?= node
APP ?= /Applications/Silico.app
PORT ?= 8744

.PHONY: extract build serve check analyze legacy-preview
extract:
	$(PYTHON) scripts/extract.py --app "$(APP)"

build:
	$(PYTHON) scripts/build_hosted.py

serve: build
	$(PYTHON) -m backend.app --port $(PORT)

legacy-preview:
	$(PYTHON) scripts/build_preview.py
	$(PYTHON) scripts/serve.py --port 8743

check:
	PYTHONDONTWRITEBYTECODE=1 $(PYTHON) -m unittest discover -s tests -p 'test_*.py' -v
	$(NODE) --test tests/*.test.mjs

analyze:
	$(PYTHON) scripts/analyze.py
