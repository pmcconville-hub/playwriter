---
'playwriter': patch
---

Bound Remote control memory use on slow connections by dropping stale screencast frames after the tunnel WebSocket buffer reaches 2 MiB. Commands and other protocol messages are never dropped.
