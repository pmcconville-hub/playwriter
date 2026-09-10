---
'playwriter': patch
---

Stop logging every Network and page-lifecycle CDP event from the Chrome extension.

On Vite HMR pages and other chatty sites, those events arrive thousands of times per second. Each one was sent over the relay WebSocket as a debug log, which starved real commands. `page.screenshot()` and `context.newPage()` then timed out, and the extension spiked CPU.

Events are still forwarded to Playwright. Only the per-event debug log is skipped.

Related to #96.
