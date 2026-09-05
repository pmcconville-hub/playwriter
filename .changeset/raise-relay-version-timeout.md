---
'playwriter': patch
---

Wait up to 10 seconds for the local relay `/version` probe before treating the daemon as dead.

A busy relay (many agents attaching Chrome tabs at once) can miss a 2 second HTTP probe. That used to look like a dead process, so `session new` killed a healthy daemon and wiped every in-memory session.

The same 10 second budget applies to `waitForRelayVersion` when port 19988 is already bound.
