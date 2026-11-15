.PHONY: setup check smoke notebook

setup:
	sh scripts/uv.sh sync --locked

check:
	sh scripts/uv.sh run --locked ruff check .
	sh scripts/uv.sh run --locked ruff format --check .
	sh scripts/uv.sh run --locked pytest -q
	sh scripts/uv.sh run --locked python -m jev_research.smoke

smoke:
	sh scripts/uv.sh run --locked python -m jev_research.smoke

notebook:
	sh scripts/uv.sh run --locked --group notebook python -m ipykernel install --prefix .venv --name jev-research --display-name 'Jev (.venv)'
	sh scripts/uv.sh run --locked --group notebook jupyter lab --no-browser
