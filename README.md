# Closing Time

A café game with turn-based, opt-in real-time play, and an autonomous simulation. You and Mara are closing up when rain starts coming
through an open window. Move with arrows, WASD, or an adjacent tile, and use
the action buttons or speak to Mara in your own words.

## Run locally

Node.js 22.12 or later is required. Set GEMINI_API_KEY in your local
environment or in an untracked .env file. GEMINI_MODEL is optional and
defaults to gemini-3.1-flash-lite.

If you have the bundle with the compiled game server, run npm start from the
extracted folder. To rebuild after editing the source, run npm ci and
npm run build first. Open http://127.0.0.1:4173.

In turn-based mode, the game calls the model once per accepted player action. It requires a
server connection during play. If the request fails, the turn stays where it
was and you can retry your action. Restart cancels an in-flight turn.

## How Mara works

The model receives the approved character prompt, the current room after your
action, recent turns and dialogue, and her legal actions. It selects one move
or interaction, or writes a short line of speech. The scene engine authorizes
both actors' actions and advances the rain after both actors have acted.
Mara's goals, movement choices and dialogue are chosen by the model each turn.

The worker keeps the credential on the server. It sends scene context and
recent in-game dialogue to Gemini.

| File | Responsibility |
| --- | --- |
| src/world.ts | Shared action validation, world changes and rain |
| src/planner.ts | Player and Mara turn sequencing |
| src/mara.ts | Prompt, model request and action selection validation |
| src/worker.ts | Game and model endpoint |
| src/main.ts | Phaser room and player controls |

## Audit a playtest

Open **Turn audit** to see Mara's stated explanation for her latest action.
Select **Export turn traces** to download a versioned JSON file containing the
room before and after the turn, the observation and recent context given to
Mara, the legal actions she could choose, her selected action and dialogue,
her stated rationale, and the model version. The explanation is generated as
part of the action response.

Completed turns are stored in the browser and grouped by scene session ID.
Restarting the scene starts a new session and keeps earlier traces. Export
traces before clearing browser data. Failed or canceled turns leave the game
state unchanged and do not create completed turn entries.


## Real-time playtest

Open the same game URL with `?mode=live` or select **Play real-time**. The
plain URL opens the turn-based scene. Both modes use the same room and player
actions, while real-time play lets you hold a direction or tap a floor tile
to walk. Rain and player input continue while Mara thinks. The scene pauses
when the page is hidden.

**Scene audit** shows what Mara selected, her stated rationale, and what the
game applied, queued, or skipped. Export the version-2 timeline for
real-time play and use the separate version-1 export for turn-based traces.
Restart and reload keep recorded traces and start a fresh scene. Export
traces before clearing browser data. Exports contain in-game dialogue.

## Autonomous simulation

Select **Watch simulation** or open `?mode=simulation`. Choose **New simulation**
to create a café run or **Resume stored scene** to claim the last saved run in
this browser. Mara, Riley, and Jo act without player input. Join on a free tile
to move, use the shared room actions, and address a character in speech. Pause
and resume the active clock, or start a new run when you want a clean scene.
The character inspector shows that actor's local view, recall, options, and
events. The audit inspector shows recent version-3 entries; **Export audit**
downloads the complete bounded trace. Import a JSON audit to view its final
checkpoint as a read-only replay preview. Import does not replace the live save
or make model requests.

## Verify the simulation in a browser

Run `npm run build`, then start the compiled worker with
`node scripts/preview-fixture.mjs --port 4173`. Open
`http://127.0.0.1:4173/?mode=simulation&fixture=simulation&run=cast1`, select
**New simulation**, and watch the cast activity. This route keeps the real
compiled worker and same-origin `/api/simulation` request/response parser, with
a synthetic Gemini provider response. It uses a faster bounded ambient interval
to make NPC initiative observable. The fixture produces a directed NPC reply
and, after Mara's witnessed line returns in her local context, a source-linked
commitment proposal. Download an audit and inspect it at
`/__fixture?key=simulation:cast1&export=3`. For save and resume, reload the
same URL and select **Resume stored scene**. For replay, choose the exported
JSON file under **Import replay for inspection**.

The local environment used for this implementation has no Gemini key. The
synthetic fixture verifies the worker contract and UI flow; live Gemini
behavior, latency, and two-minute spectator runs remain unmeasured.

## Verify changes

Run `npm ci`, `npm run build`, and `npm test`. The tests cover both modes,
elapsed rain, shared movement, inference failure, stale responses, and
audit compatibility without contacting Gemini.

For rendered checks, run `node scripts/preview-fixture.mjs` and open the
loopback game URL on port 4173. In a managed Sites workspace, use the
configured Sites preview launcher to run that command with the compiled
worker. Query parameters select the synthetic model scenario:

| URL suffix | Check |
| --- | --- |
| `?fixture=fixed&run=baseline` | One Wait produces one request, one turn, and one version-1 trace. |
| `?fixture=failure&run=baseline-error` | A failed request leaves the baseline scene and trace count unchanged. |
| `?mode=live&fixture=delay&run=responsive` | Move and interact while the fixture panel says a response is pending. Use **Release model response** to let the decision resolve. |
| `?mode=live&fixture=stale&run=window` | Let Mara reach the window, then close it from the player side before releasing the pending response. The old close is skipped. |
| `?mode=live&fixture=rate-limit` or `?mode=live&fixture=timeout` | The player stays in control through backoff or timeout. |
| `?mode=simulation&fixture=simulation&run=cast1` | The cast uses the compiled simulation endpoint, starts a directed exchange, and supplies witnessed evidence for a memory proposal. |

Use a new alphanumeric `run` token to separate fixture counters. In the
browser, also restart with a response pending, switch modes, then download
and verify both export formats. If the browser cannot expose a downloaded
file, the localhost fixture retains the JSON generated by the export button.
Inspect `/__fixture?key=<fixture>:<run>&export=1`, `export=2`, or `export=3`. Use synthetic
dialogue in this fixture. Its model requests do not count toward the Gemini
quota.

For real inference verification, start the local game with `npm start` and run
`node .agents/skills/verify/scripts/verify.mjs "$PWD" --gemini`. Set
`GEMINI_API_KEY` in the environment or in the checkout's `.env` file. The
verifier checks both game modes through the local server. The verification
guide also covers rendered play and audit exports.
