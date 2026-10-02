UUID    = kiro-crew@totoshko88.github.io
SRC     = $(UUID)
INSTALL = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall enable disable pack lint validate clean test test-logic

all: schemas

# Run the pure-logic unit tests (no gnome-shell required).
test-logic:
	gjs -m tests/test-state.js

# Lint the extension sources with ESLint. No-op (with a note) if eslint is not
# installed, so a source checkout without node_modules can still run `make lint`.
lint:
	@if command -v eslint >/dev/null 2>&1 || [ -x node_modules/.bin/eslint ]; then \
		npx eslint "$(SRC)/*.js" "$(SRC)/lib/*.js"; \
	else \
		echo "eslint not installed (run 'npm ci'); skipping lint"; \
	fi

# Validate against the GNOME Extension Review (EGO) guidelines.
validate:
	bash tests/validate-review-guidelines.sh

# Compile the GSettings schema in place (required before enabling).
schemas:
	glib-compile-schemas $(SRC)/schemas

install: schemas
	mkdir -p "$(INSTALL)"
	cp -r $(SRC)/* "$(INSTALL)/"
	@echo "Installed. Log out/in (Wayland) or Alt+F2 'r' (X11), then:"
	@echo "  gnome-extensions enable $(UUID)"

uninstall:
	rm -rf "$(INSTALL)"

enable:
	gnome-extensions enable $(UUID)

disable:
	gnome-extensions disable $(UUID)

# Nested test session (Wayland). Shell 49+ uses --devkit instead of --nested.
test:
	dbus-run-session gnome-shell --nested --wayland

# Build the distributable zip. We use plain `zip` rather than
# `gnome-extensions pack` so CI runners don't need the full gnome-shell package
# (the CLI isn't in gnome-shell-common — that was Error 127). The archive layout
# matches pack: the extension's files sit at the ZIP root, not under a subdir.
# Only the gschema.xml source is shipped: for Shell 45+ EGO / gnome-extensions
# install compile it themselves, and a shipped gschemas.compiled is flagged by
# review (EGO-P-006). `make install` still compiles for local dev copies.
pack:
	rm -f $(UUID).shell-extension.zip
	cd $(SRC) && zip -qr ../$(UUID).shell-extension.zip . -x 'schemas/gschemas.compiled'
	@echo "built $(UUID).shell-extension.zip"

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
