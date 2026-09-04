---
'playwriter': patch
---

Wait for `Debugger.scriptParsed` after enabling the debugger, so `listScripts()` sees scripts that were already on the page.

Chrome only re-emits parsed scripts after `Debugger.enable` returns. The previous 100ms wait started before enable finished, so `listScripts()` could return an empty list on a loaded page.
