#!/usr/sh
# Test stub: records argv and exits (never launches a real browser).
echo "FAKE_CHROME" >> "${FAKE_CHROME_LOG:-/tmp/fake-chrome.log}" 2>/dev/null || true
printf '%s\n' "$@" >> "${FAKE_CHROME_LOG:-/tmp/fake-chrome.log}" 2>/dev/null || true
echo "DevTools listening on ws://127.0.0.1:${FAKE_CHROME_PORT:-0}/devtools/browser/fake"
exit 0