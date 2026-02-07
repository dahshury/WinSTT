.DEFAULT_GOAL := all
format:
	uv run ruff format .
lint:
	uv run ruff check . --fix
mypy:
	uv run mypy src
test:
	uv run pytest
check: format lint mypy test
all: check
