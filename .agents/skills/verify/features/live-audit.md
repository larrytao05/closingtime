# Real-time audit

Scene audit distinguishes Mara's selected action from what the game applied and exports the timeline.

## Sub-features

- Decision and outcome inspection; version-2 timeline and version-1 trace export.

## How to get to it (user POV)

- In real-time play open **Scene audit**, then use **Export timeline** or **Export turn traces**.

## Driving it with a browser

Preconditions: `/?mode=live&fixture=delay&run=UNIQUE`, with a decision pending.

- Release the response, open **Scene audit**, and capture the selected action, explanation, and applied or skipped outcome. Check the explanation against the visible state.
- Click **Export timeline**, inspect version 2, event/session IDs, observation, request timing and terminal outcome. Restart and reload, then verify prior sessions remain.
- Use **Export turn traces** to check the separate version-1 export. Fixture fallback after clicking each button is `/__fixture?key=delay:UNIQUE&export=2` or `export=1`.

## Gotchas

- Model decisions and applied actions can differ when the scene changes during inference. Exported dialogue is private playtest data; use synthetic text.
