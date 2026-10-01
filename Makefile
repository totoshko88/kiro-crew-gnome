UUID    = kiro-crew@totoshko88.github.io
SRC     = $(UUID)
INSTALL = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)

.PHONY: all schemas install uninstall enable disable pack lint clean test test-logic

all: schemas

# Run the pure-logic unit tests (no gnome-shell required).
test-logic:
	gjs -m tests/test-state.js

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

pack: schemas
	gnome-extensions pack $(SRC) \
		--extra-source=lib \
		--extra-source=icons \
		--force \
		--out-dir=.

clean:
	rm -f $(SRC)/schemas/gschemas.compiled
	rm -f $(UUID).shell-extension.zip
