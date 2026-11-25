# Real-time play

Player input and rain continue while Mara's model request is pending.

## Sub-features

- Mode switch, movement, interactions, pending decision, and restart.

## How to get to it (user POV)

- Choose **Play real-time** or open `/?mode=live&fixture=delay&run=UNIQUE`.

## Driving it with a browser

Preconditions: fresh disposable profile and delay fixture.

- Capture the initial scene. Wait for the fixture panel to show a pending request; move twice with arrow keys and perform a reachable interaction. Capture the changed position or state while the request remains pending.
- Click **Release model response** and observe Mara's resulting action and scene audit. Restart or switch modes with a new response pending; release the old response and check it does not alter the new session.
- Exercise timeout or rate-limit scenarios via the documented fixture URLs and verify the player retains control.

## Gotchas

- The scene pauses when hidden. The fixture panel reports request state; it is not a user-facing production feature or a live model call.
