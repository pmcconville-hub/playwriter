---
'playwriter': minor
---

Add tab group controls to remote-control sessions. Shared tabs now join a `remote` group by default, and remote agents can set the group title and color when they connect or later with `session update`.

```sh
playwriter session new --remote <id> --tab-group support
playwriter session update 1 --tab-group review --tab-group-color cyan
```
