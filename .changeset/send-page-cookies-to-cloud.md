---
'playwriter': minor
---

Add a `cloud` helper to local CLI execution sessions. It lists active cloud browsers and sends cookies for the current page into a selected cloud browser without printing or saving cookie values.

```js
const browsers = await cloud.browsers.list()
await cloud.sendCookies({ to: browsers[0] })
```

Pass `from` to use another page or `urls` when a login uses more than one HTTP origin.
