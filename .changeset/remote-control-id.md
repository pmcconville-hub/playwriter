---
'playwriter': patch
---

`--remote` now takes the share **id**, not a full URL.

```bash
playwriter session new --remote abc123
```

The toolbar copies this form in the agent prompt. Paste the id from there.
