.DEFAULT_GOAL := all
format:
	uv run ruff format .
lint:
	uv run ruff check . --fix
mypy:
	uv run mypy src
test:
	uv run pytest
crap:
	uv run python scripts/crap.py
crap-fast:
	uv run python scripts/crap.py --skip-coverage
crap-strict:
	uv run python scripts/crap.py --strict --threshold 4
check: format lint mypy test
all: check
