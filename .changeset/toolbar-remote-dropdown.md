---
'playwriter': patch
---

Tighten the in-page toolbar and make **Remote ON** a dropdown.

**Copy Locator** is now a labeled button with a smaller icon. Toolbar type is 11px, with tighter padding and gaps.

While a tab is shared, **Remote ON** opens a menu:

- **Copy remote URL** copies the live-view link (`https://playwriter.dev/remote-control#…`)
- **Copy agent prompt** copies a short connect prompt for the agent
- **Stop sharing** revokes the link, same as the old direct click

The agent prompt is now a few lines: the quoted `session new --remote-control` command, a pointer to `https://playwriter.dev/SKILL.md`, and a warning not to share the URL.

Starting a share asks a short confirm with a **Read more** link to https://playwriter.dev/docs/remote-control
