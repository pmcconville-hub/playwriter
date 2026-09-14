---
'playwriter': minor
---

Remote-control tunnels now use a path-based URL instead of a subdomain. The tunnel id travels as `wss://playwriter.dev/tunnel/{id}/extension` (upstream dials `wss://playwriter.dev/tunnel/{id}/upstream`), so the secret id no longer leaks through DNS queries or TLS SNI where anyone on the network path could read it. Subdomain URLs (`{id}-tunnel.playwriter.dev`) still work so older extensions keep connecting.

```sh
playwriter session new --remote <id>   # unchanged, now dials the path-based tunnel
```

The relay keys remote dials by the full WebSocket URL, so several shared ids on the path form stay distinct tunnels.
