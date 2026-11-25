# Turn-based play

The player and Mara take one action each while rain affects the papers.

## Sub-features

- Movement by keyboard or adjacent tile; Wait and reachable action buttons.
- Free-form speech, invalid input, failure, and restart.

## How to get to it (user POV)

- Open `/?fixture=fixed&run=UNIQUE` or choose the turn-based mode link from real-time play.

## Driving it with a browser

Preconditions: fixture server and disposable profile; fresh scene at Turn 0.

- Capture the initial room, Turn 0 and café state. Click **Wait**; check Turn 1, recent activity, and the fixture's one-call count. Record the resulting state.
- Restart, then try an arrow key and an adjacent floor tile separately. Check each accepted move advances the turn and visibly moves the player.
- Enter synthetic text in **Say something to Mara**, click **Say**, and check recent activity and the next turn. Submit empty text and verify no turn advances.
- In a new `?fixture=failure&run=UNIQUE` session, click **Wait**. Check the error, unchanged room and turn, and no new completed trace.
- Click **Restart scene** and check the initial state. Capture before and after each action.

## Gotchas

- The fixture chooses speech; its response is not a Gemini result. Movement may be blocked by the room or another actor; test an available adjacent tile.
- Browser storage persists across restarts; use a fresh profile to establish trace counts.
