---
'playwriter': minor
---

Add custom tab group names per session. Tabs created by a session join a Chrome tab group named after the session's `--tab-group` (default `playwriter`), so multiple agents sharing one browser keep their tabs visually separate. Collapse a group you don't care about or park it in a minimized window.

```bash
# Tabs created by this session join a group named "docs"
playwriter session new --tab-group docs

# Pick the group color yourself (grey, blue, red, yellow, green, pink, purple, cyan, orange)
playwriter session new --tab-group docs --tab-group-color blue

# Rename the group later — moves the session's existing tabs
playwriter session update 1 --tab-group research

# Change only the color — also recolors the default playwriter group
playwriter session update 1 --tab-group-color red
```

Details:

- Use the shortest clear single-word group name with no spaces, such as `docs`, `shop`, `test`, or `scrape`.
- Without `--tab-group-color`, each custom group gets a deterministic color from its name; the default `playwriter` group stays green.
- `session update` accepts `--tab-group` and/or `--tab-group-color`: rename, recolor, or both in one call.
- Recoloring the default group lasts while that session still has tabs in it. When those tabs close, the group goes back to green.
- `playwriter session list` shows the group in a new `GROUP` column.
- Dragging a tab between playwriter groups keeps the connection; the tab simply adopts the new group. Dragging it out of all playwriter groups still disconnects it.
- Moving a whole group to another window (Chrome's "Move group to new window") no longer disconnects its tabs — group-change events are re-checked after a short delay before disconnecting.
- Popups and child tabs inherit the opener tab's group.
- Renaming a session still on the default group only moves tabs that session created; manually enabled tabs and other sessions' tabs are never stolen. Renaming a custom group moves everything in it.
- A group name that collides with one of your own Chrome groups is safe: playwriter never ungroups tabs it didn't group itself.
- Leftover groups from dead sessions are cleaned up, including after service worker restarts.
- Only extension sessions support tab groups; `--tab-group` warns and is ignored for headless, direct CDP, cloud, and remote-control sessions.
- Backwards compatible: old extensions ignore the group name (tabs land in the default group) and `session update` degrades to a warning.
