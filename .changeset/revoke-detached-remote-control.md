---
'playwriter': patch
---

Fix Remote control revocation and toolbar state.

Chrome debugger detaches and shared-tab closure now revoke the active link. Remote control also uses explicit start and stop actions, with state synchronized across the shared tab and its popups.
