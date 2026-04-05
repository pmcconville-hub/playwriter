# Memory

## Auto-returned values in playwriter CLI: skip useless Playwright handles (Apr 2026)

The CLI auto-returns single-expression code (e.g. `await page.goto(url)`).
Playwright methods return handle objects (Response, Page, Browser, Locator)
that are useless to print — they're programmatic references, not display
data. The user does NOT want a hint message either — just silently skip.

Rule: if auto-returned value is a ChannelOwner (duck-type: `_type` +
`_guid` + `_connection`), emit nothing. The `Code executed successfully
(no output)` fallback handles the "nothing else printed" case.

User must explicitly `console.log(response)` or return specific fields
(`return response.url()`) to see data. `console.log` still works safely
via the playwright-core custom inspect handler.

## Playwright browsers install is broken locally (Apr 2026)

`pnpm exec playwright install` fails with `Command "playwright" not found`
because this repo uses `@xmorse/playwright-core` not `playwright`. The core
CLI `node playwright/packages/playwright-core/cli.js install chromium` also
fails with `TypeError: onExit is not a function`.

Workaround for `pnpm test` (which needs `chromium-1209`): symlink the
already-installed 1208 build to 1209. Tests launchPersistentContext and
work with the slightly older binary:

```bash
ln -sf ~/Library/Caches/ms-playwright/chromium-1208 \
       ~/Library/Caches/ms-playwright/chromium-1209
ln -sf ~/Library/Caches/ms-playwright/chromium_headless_shell-1208 \
       ~/Library/Caches/ms-playwright/chromium_headless_shell-1209
```

For standalone integration tests: pass
`executablePath: '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'`
to `chromium.launch({ headless: true, executablePath })`.

## Node util.inspect bypasses Proxy traps (Apr 2026)

Node's `util.inspect` does NOT invoke Proxy `get` traps when looking up
`Symbol.for('nodejs.util.inspect.custom')`. It reads the symbol property
directly from the proxy target object.

To expose a custom inspect handler on a proxied object, the symbol MUST be
set on the underlying target, not via the proxy's `get` trap:

```ts
// BAD — never fires
new Proxy(target, {
  get: (obj, prop) => {
    if (prop === Symbol.for('nodejs.util.inspect.custom'))
      return () => 'custom output'
    return obj[prop]
  },
})

// GOOD — works
target[Symbol.for('nodejs.util.inspect.custom')] = function () {
  return 'custom output'
}
const proxy = new Proxy(target, { get: (obj, prop) => obj[prop] })
```

Direct property access `proxy[Symbol.for('nodejs.util.inspect.custom')]`
DOES go through the proxy get trap — only `util.inspect`'s internal lookup
bypasses it.

## Playwright ChannelOwner leaks process.env via util.inspect (issue #82)

Playwright's `ChannelOwner._connection._platform.env` is set to `process.env`
on node. At depth 4, `util.inspect(response)` traverses:

```
Response → _connection → _platform → env: { ALL_ENV_VARS }
```

This dumps every environment variable (API keys, tokens, passwords).
Happened whenever a user auto-returned a Playwright object from the CLI,
e.g. `playwriter -s 1 -e 'await page.goto(url)'`.

Fix: custom `[Symbol.for('nodejs.util.inspect.custom')]` on ChannelOwner
prototype + on the channel proxy target. See
`playwright/packages/playwright-core/src/client/channelOwner.ts`.
