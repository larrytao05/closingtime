# Closing Time

A turn-based café game. You and Mara are closing up when rain starts coming
through an open window. Move with arrows, WASD, or an adjacent tile, and use
the action buttons or speak to Mara in your own words.

## Run locally

Node.js 22.12 or later is required. Set GEMINI_API_KEY in your local
environment or in an untracked .env file. GEMINI_MODEL is optional and
defaults to gemini-3.1-flash-lite.

If you have the bundle with the compiled game server, run npm start from the
extracted folder. To rebuild after editing the source, run npm ci and
npm run build first. Open http://127.0.0.1:4173.

The game calls the model once per successful player action. It requires a
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
