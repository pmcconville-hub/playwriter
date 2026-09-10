---
'playwriter': patch
---

Keep reconnect from wiping attached tabs after a busy local relay handshake.

The extension now closes inventory handshake failures with browser-safe codes `4005`/`4006` instead of `1011`, which Chrome rejects with `InvalidAccessError`. After reconnect, a stale tab-group ungroup event no longer detaches tabs that are already back in the Playwriter group.
