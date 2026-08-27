---
'playwriter': patch
---

Move the in-page toolbar into Chrome's isolated extension world so websites can no longer trigger **Record Skill** or **Remote control**.

Before, the toolbar ran in the page's own JavaScript world and reached the extension through a `window.postMessage` bridge. Any script on the page could post the same message and start a recording or open a remote-control tunnel without a click:

```js
// previously enough for any website to start recording
window.postMessage({ __playwriter: 'recorder_start' }, '*')
```

That bridge is gone. The toolbar now calls `chrome.runtime.sendMessage()` directly from the isolated world, so its callbacks are invisible to page scripts:

```text
Website JavaScript                    Extension isolated world

cannot see the callbacks              closed Shadow DOM toolbar
cannot reach chrome.runtime                    │ trusted click
cannot post a forged message                   ▼
                                      chrome.runtime.sendMessage()
                                               │
                                               ▼
                                      service worker
```

What changed for you:

- Privileged buttons require a **real user click** with an active user gesture, and the service worker only accepts them from the top frame of a connected tab
- Prompts and pinned-element commands are copied by an **offscreen extension document**, so a page can no longer rewrite what lands on your clipboard
- The toolbar host uses `all:initial` and refuses clicks when a page hides, filters, covers, or moves it, which blocks click-hijacking
- When a page does restyle the toolbar, a toast now explains why the click was ignored

The toolbar looks exactly the same.
