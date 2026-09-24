---
'playwriter': patch
---

Document how to build a standalone typed TypeScript SDK from a recording. The `recorder start` instructions, `recorder stop` next steps, `playwriter skill`, and the skill recorder docs now show how to import `connectViaExtension` from `playwriter`, run `fetch` inside the page, and auto-close the connection with `await using`. They link to https://playwriter.dev/docs/sessions#node-api.

```ts
import { connectViaExtension } from 'playwriter'

await using connection = await connectViaExtension({ tabGroup: 'docs' })
const page = await connection.browser.contexts()[0].newPage()
await page.goto('https://example.com')
```
