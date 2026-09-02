---
'playwriter': patch
---

Fix remote-control execute failing with the local Chrome extension error when the tunnel blips.

After `session new --remote-control`, the public dial can drop (`1006`) then lose a race with the extension reconnect (`4008 Tunnel offline`). Execute used to fail immediately and tell you to install the Chrome extension.

The relay now waits past the extension reconnect before redialing, retries `4008` in 500ms, and execute waits up to 8s for the shared tab to come back. If it is still down, the error asks you to check Remote control is on.
