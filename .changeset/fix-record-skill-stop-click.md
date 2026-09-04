---
'playwriter': patch
---

Keep **Record Skill** clickable while the recorder is starting, and honor a second click as stop.

The Starting state used `pointer-events: none`, so a click meant to stop was ignored. The button width also jumped from Record Skill to Stop recording, which shifted the centered toolbar. The control now keeps a stable width, and a click during start stops the recording once it attaches.
