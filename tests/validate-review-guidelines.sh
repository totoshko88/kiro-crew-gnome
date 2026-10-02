#!/bin/bash

# GNOME Extension Review Guidelines Validation Script
# Validates the extension against GNOME Extension Review Guidelines.
# Paths are scoped to the nested extension subdir.

UUID="kiro-crew@totoshko88.github.io"
EXT="$UUID"

echo "=== GNOME Extension Review Guidelines Validation ==="
echo "Extension dir: $EXT"
echo ""

PASSED=0
FAILED=0
WARNINGS=0

# Helper functions
pass() {
    echo "✓ PASS: $1"
    ((PASSED++))
}

fail() {
    echo "✗ FAIL: $1"
    ((FAILED++))
}

warn() {
    echo "⚠ WARNING: $1"
    ((WARNINGS++))
}

info() {
    echo "ℹ INFO: $1"
}

echo "=== 1. Checking for Synchronous Blocking Operations ==="
echo ""

# Check for synchronous subprocess calls
if grep -r "Gio\.Subprocess\.new.*SYNC" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    fail "Found synchronous subprocess calls (should use async)"
else
    pass "No synchronous subprocess calls found"
fi

# Check for synchronous file operations
if grep -r "\.load_contents\b" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | grep -v "async\|_async"; then
    warn "Found potentially synchronous file operations"
else
    pass "No synchronous file operations found"
fi

# Check for blocking sleep/wait calls
if grep -r "GLib\.usleep\|spawn_command_line_sync" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    warn "Found potential blocking/synchronous calls"
else
    pass "No blocking sleep/sync calls found"
fi

echo ""
echo "=== 2. Checking Enable/Disable Lifecycle ==="
echo ""

# Check extension.js has enable() method
if grep -q "enable()" "$EXT/extension.js"; then
    pass "enable() method found in extension.js"
else
    fail "enable() method not found in extension.js"
fi

# Check extension.js has disable() method
if grep -q "disable()" "$EXT/extension.js"; then
    pass "disable() method found in extension.js"
else
    fail "disable() method not found in extension.js"
fi

# Check disable() cleans up resources
if grep -A 20 "disable()" "$EXT/extension.js" | grep -q "stop\|destroy\|disconnect\|null"; then
    pass "disable() method appears to clean up resources"
else
    warn "disable() method may not properly clean up resources"
fi

# Check for proper signal disconnection
if grep -r "\.disconnect(" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | grep -q "signalId\|_signalIds\|Id"; then
    pass "Signal disconnection found in code"
else
    warn "No explicit signal disconnection found"
fi

# Check for timeout cleanup
if grep -r "GLib\.source_remove" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    pass "Timeout cleanup (GLib.source_remove) found"
else
    warn "No timeout cleanup found"
fi

echo ""
echo "=== 3. Checking Import Restrictions ==="
echo ""

# Check extension.js doesn't import GTK
if grep -q "from 'gi://Gtk'" "$EXT/extension.js"; then
    fail "extension.js imports GTK (not allowed)"
else
    pass "extension.js does not import GTK"
fi

if grep -q "from 'gi://Adw'" "$EXT/extension.js"; then
    fail "extension.js imports Adw (not allowed)"
else
    pass "extension.js does not import Adw"
fi

# Check prefs.js doesn't import Shell UI resources
if grep -q "resource:///org/gnome/shell/ui" "$EXT/prefs.js"; then
    fail "prefs.js imports Shell UI modules (not allowed)"
else
    pass "prefs.js does not import Shell UI modules"
fi

# Check prefs.js uses correct imports
if grep -q "from 'gi://Gtk'" "$EXT/prefs.js" && grep -q "from 'gi://Adw'" "$EXT/prefs.js"; then
    pass "prefs.js uses correct GTK/Adw imports"
else
    warn "prefs.js may not have correct imports"
fi

echo ""
echo "=== 4. Checking metadata.json ==="
echo ""

META="$EXT/metadata.json"

# Check metadata.json exists
if [ -f "$META" ]; then
    pass "metadata.json exists"

    # Validate JSON syntax
    if python3 -m json.tool "$META" > /dev/null 2>&1; then
        pass "metadata.json is valid JSON"
    else
        fail "metadata.json is not valid JSON"
    fi

    # Check required fields. A version may be expressed as the EGO integer
    # "version" OR the semantic "version-name" (this project uses version-name
    # pre-EGO-upload; the release workflow adds the integer version).
    for field in uuid name description shell-version; do
        if grep -q "\"$field\"" "$META"; then
            pass "metadata.json contains required field: $field"
        else
            fail "metadata.json missing required field: $field"
        fi
    done

    if grep -q "\"version-name\"" "$META" || grep -q "\"version\"" "$META"; then
        pass "metadata.json contains a version field (version-name or version)"
    else
        fail "metadata.json missing version / version-name field"
    fi

    # Check UUID format
    if grep -q "\"uuid\".*@" "$META"; then
        pass "UUID contains @ symbol (correct format)"
    else
        fail "UUID should contain @ symbol"
    fi

else
    fail "metadata.json not found"
fi

echo ""
echo "=== 5. Checking GSettings Schema ==="
echo ""

# Check schema file exists
SCHEMA_FILE=$(find "$EXT/schemas" -name "*.gschema.xml" -type f 2>/dev/null | head -n 1)
if [ -n "$SCHEMA_FILE" ] && [ -f "$SCHEMA_FILE" ]; then
    pass "GSettings schema file exists"

    # Check schema ID matches convention
    if grep -q "id=\"org.gnome.shell.extensions" "$SCHEMA_FILE"; then
        pass "Schema ID follows naming convention"
    else
        fail "Schema ID should start with org.gnome.shell.extensions"
    fi

    # Check schema has path
    if grep -q "path=\"/org/gnome/shell/extensions" "$SCHEMA_FILE"; then
        pass "Schema has correct path"
    else
        warn "Schema path may not follow convention"
    fi

    # Validate XML syntax (if xmllint available)
    if command -v xmllint > /dev/null 2>&1; then
        if xmllint --noout "$SCHEMA_FILE" 2>&1; then
            pass "Schema XML is valid"
        else
            fail "Schema XML is invalid"
        fi
    else
        info "xmllint not available, skipping XML validation"
    fi

else
    fail "GSettings schema file not found"
fi

echo ""
echo "=== 6. Checking Code Quality ==="
echo ""

# Check for console.log (should use log() or logError())
if grep -r "console\.log\|console\.error" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    warn "Found console.log/error (should use log() or logError())"
else
    pass "No console.log/error found"
fi

# Check for proper error handling
if grep -r "try\s*{" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | wc -l | grep -q "[1-9]"; then
    pass "Error handling (try-catch) found in code"
else
    warn "Limited error handling found"
fi

# Check for async/await usage
if grep -rE "async\s+\w+\s*\(|async\s*\(" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | wc -l | grep -q "[1-9]"; then
    pass "Async functions found in code"
else
    warn "No async functions found"
fi

# Check for proper Promise handling
if grep -r "\.then(\|\.catch(" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    pass "Promise handling found in code"
else
    info "No explicit Promise handling found (may use async/await)"
fi

echo ""
echo "=== 7. Checking File Structure ==="
echo ""

# Check required files exist
for file in extension.js metadata.json; do
    if [ -f "$EXT/$file" ]; then
        pass "Required file exists: $file"
    else
        fail "Required file missing: $file"
    fi
done

# Check for prefs.js if settings are used
if [ -f "$EXT/prefs.js" ]; then
    pass "prefs.js exists (for settings UI)"
else
    info "prefs.js not found (no settings UI)"
fi

# Check for stylesheet
if [ -f "$EXT/stylesheet.css" ]; then
    pass "stylesheet.css exists"
else
    info "stylesheet.css not found (no custom styling)"
fi

echo ""
echo "=== 8. Checking Resource Management ==="
echo ""

# Check for proper object destruction
if grep -r "destroy()" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | grep -v "^Binary"; then
    pass "destroy() methods found for cleanup"
else
    warn "No destroy() methods found"
fi

# Check for null assignments in cleanup
if grep -A 10 "disable()" "$EXT/extension.js" | grep -q "= null"; then
    pass "Resources set to null in disable()"
else
    warn "Resources may not be properly nullified in disable()"
fi

# Check for signal tracking
if grep -r "_signalIds\|_signals\|signalId" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    pass "Signal tracking found in code"
else
    warn "No signal tracking found (may lead to leaks)"
fi

echo ""
echo "=== 9. Checking Security ==="
echo ""

# Check for shell command injection risks
if grep -r "GLib\.spawn\|exec\|system(" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    warn "Found potential shell command execution (check for injection risks)"
else
    pass "No direct shell command execution found"
fi

# Check subprocess uses array arguments (not shell strings)
if grep -r "Gio\.Subprocess\.new" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null; then
    if grep -A 2 "Gio\.Subprocess\.new" "$EXT"/*.js "$EXT"/lib/*.js | grep -q "\[.*\]"; then
        pass "Subprocess uses array arguments (safe)"
    else
        warn "Subprocess may not use array arguments"
    fi
else
    pass "No subprocess usage found"
fi

# Check for sensitive data handling (generic token/secret check)
if grep -r "password\|token\|secret" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | grep -iE "log\(|logError\(|print\(" | grep -v "sanitize\|replace"; then
    warn "Found sensitive data near logging (ensure tokens/secrets are never logged)"
else
    pass "No sensitive data logged (token/secret check)"
fi

echo ""
echo "=== 10. Checking Documentation ==="
echo ""

# Check for README
if [ -f README.md ] || [ -f README ]; then
    pass "README file exists"
else
    warn "README file not found"
fi

# Check for LICENSE
if [ -f LICENSE ] || [ -f COPYING ]; then
    pass "LICENSE file exists"
else
    warn "LICENSE file not found"
fi

# Check for code comments
if grep -r "^[[:space:]]*//\|^[[:space:]]*\*" "$EXT"/*.js "$EXT"/lib/*.js 2>/dev/null | wc -l | grep -q "[1-9][0-9]"; then
    pass "Code comments found"
else
    warn "Limited code comments found"
fi

echo ""
echo "=== Validation Summary ==="
echo "Passed: $PASSED"
echo "Failed: $FAILED"
echo "Warnings: $WARNINGS"
echo ""

if [ $FAILED -eq 0 ]; then
    if [ $WARNINGS -eq 0 ]; then
        echo "✓ Extension fully complies with GNOME Extension Review Guidelines"
        exit 0
    else
        echo "⚠ Extension mostly complies with guidelines, but has $WARNINGS warnings"
        exit 0
    fi
else
    echo "✗ Extension has $FAILED compliance issues that must be fixed"
    exit 1
fi
