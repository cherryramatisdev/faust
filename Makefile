.PHONY: check-deno install build

check-deno:
	@if ! command -v deno >/dev/null 2>&1; then \
		echo "Deno is required but was not found on PATH."; \
		echo "Install mise (https://mise.jdx.dev/getting-started.html), then run 'mise install' in this directory to install the pinned tool."; \
		exit 1; \
	fi

install: check-deno
	deno install --frozen --allow-scripts=npm:esbuild,npm:node-pty

build: install
	deno task build
