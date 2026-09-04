---
'playwriter': patch
---

Write screen recording chunks directly to a temporary file instead of retaining the full video in memory. Failed or disconnected captures remove partial output, and recording stop waits for the final encoded chunk.
