---
'playwriter': patch
---

`connectViaExtension()` connections now support `await using`, so they close automatically at scope end, also when code throws. No `try/finally` needed. `close()` is now idempotent, so calling it manually before dispose is safe.

```ts
import { connectViaExtension } from 'playwriter'

async function getTitle() {
  await using connection = await connectViaExtension({ tabGroup: 'docs' })
  const page = await connection.browser.contexts()[0].newPage()
  await page.goto('https://example.com')
  return await page.title()
} // pages closed, CDP disconnected, session deleted
```

Needs Node 24+ for native `await using`, or TypeScript 5.2+ / tsx.
