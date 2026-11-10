.PHONY: help install dev build typecheck test check package package-protocol clean

help:
	@echo "rea-claude targets:"
	@echo "  make install    npm ci (or npm install when no lockfile)"
	@echo "  make dev        run the app with hot reload (electron-vite dev)"
	@echo "  make build      production build into out/"
	@echo "  make typecheck  tsc for main/preload and renderer projects"
	@echo "  make test       vitest unit tests"
	@echo "  make check      typecheck + test + build"
	@echo "  make package    unsigned macOS .app into dist/ (electron-builder --dir)"
	@echo "  make package-protocol  same, but Info.plist declares silico:// (opt-in, see D3)"

install:
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi

dev:
	npm run dev

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm test

check: typecheck test build

package:
	npm run package:mac

package-protocol:
	npm run package:mac:protocol

clean:
	rm -rf out dist
