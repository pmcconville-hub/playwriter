---
'playwriter': minor
---

Remove the default `page` global from the execution sandbox. Playwriter never opens a tab on its own anymore.

Before, every execute call made sure a default page existed. If no tab was open, the executor or the relay opened an `about:blank` tab, even when your code never used `page`. An SDK that opened and closed its own page still left a blank tab behind.

Now:

- Reading `page` throws with a hint to get a page from `context`.
- The relay no longer auto-creates a tab when a client connects with zero tabs. `PLAYWRITER_AUTO_ENABLE` is removed.
- Headless and direct CDP sessions start without a tab.
- Helpers need an explicit page: `snapshot`, `getLatestLogs`, `waitForPageLoad`, `refToLocator`, `screenshotWithAccessibilityLabels`, `getPageMarkdown`, `ghostCursor.*`, `recording.*`, `stream.*`, and `cloud.sendCookies({ from })`. `snapshot` also accepts a `locator` or `frame`.
- `playwriter stream start` streams `state.page`. `stream stop` and `stream status` also work without `state.page` (for example after a session reset): they target the only active stream, and ask you to pick a page when several streams run.
- `reset` (MCP tool, CLI, and `/cli/reset`) no longer reports a current page URL.

Migrate by storing your own page in `state`:

```js
// new tab
state.page = await context.newPage()
await state.page.goto('https://example.com')

// a tab the user already opened (last match = most recently opened)
state.page = context.pages().findLast((p) => p.url().includes('example.com'))

await snapshot({ page: state.page })
```
