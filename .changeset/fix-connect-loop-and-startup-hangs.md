---
'playwriter': patch
---

Fix frequent extension connect/disconnect loops and startup hangs on Chrome 153 (#40).

**Fix a connect/disconnect race.** A `connect()` attempt that lost the global timeout
race could still install its late WebSocket over a newer attempt, leaving two live
sockets and triggering "Extension Already In Use" churn. A monotonic attempt id now
makes superseded sockets go inert.

**Stop startup hangs resolving identity.** `chrome.storage.local`,
`chrome.identity.getProfileUserInfo`, and the high-entropy User-Agent lookup are now
bounded with a 2s timeout (falling back to existing defaults), so identity resolution
can no longer block the relay connection.

**Stop a stalled debugger detach from blocking startup.** Startup debugger cleanup now
bounds each `chrome.debugger.detach` and isolates failures, so one target stuck in
`DETACH_STALLED_IN_STOPPING` cannot stall the restart chain.
