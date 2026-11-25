# Turn audit and export

The audit shows Mara's explanation and exports completed turn traces across scene sessions.

## Sub-features

- View a decision and rationale; export and retain version-1 traces after restart and reload.

## How to get to it (user POV)

- In turn-based play, open **Turn audit** and choose **Export turn traces**.

## Driving it with a browser

Preconditions: fresh profile at `/?fixture=fixed&run=UNIQUE`.

- Click **Wait**, open **Turn audit**, and capture the chosen action, rationale and trace count. The fixed fixture says “I see the papers.”
- Click **Export turn traces**. Inspect the downloaded JSON for schema version 1, session ID, timestamps, observation, legal actions, choice and rationale, and resulting world. Compare with the screen.
- Restart, take another turn, reload, and export again. Verify both sessions and their traces remain. For fixture-only fallback after clicking export, fetch `/__fixture?key=fixed:UNIQUE&export=1` and save the JSON as evidence.

## Gotchas

- Exports contain dialogue. Use synthetic text and keep artifacts out of Git. Do not clear storage between the persistence steps.
