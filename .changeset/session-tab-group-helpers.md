---
'playwriter': patch
---

Add `connectViaExtension()` so Node programs can open a Playwriter session, connect over CDP, and close it without posting `/cli/session/new` themselves.

```ts
import { connectViaExtension } from 'playwriter'

const connection = await connectViaExtension({
  tabGroup: 'email-check',
  tabGroupColor: 'grey',
})
const page = await connection.browser.contexts()[0].newPage()
await page.goto('https://example.com')
await connection.close()
```

`tabGroupColor` is typed as Chrome's tab group colors. `close()` closes leftover pages, disconnects CDP, and deletes the session.
