---
'playwriter': patch
---

Add Node helpers to create and delete Playwriter sessions with a tab group.

```ts
import { createRelaySession, deleteRelaySession, getCdpUrl } from 'playwriter'

const session = await createRelaySession({
  tabGroup: 'email-check',
  tabGroupColor: 'grey',
})
const browser = await chromium.connectOverCDP(
  getCdpUrl({
    sessionId: session.id,
    tabGroup: 'email-check',
    tabGroupColor: 'grey',
  }),
)
await deleteRelaySession({ sessionId: session.id })
```
