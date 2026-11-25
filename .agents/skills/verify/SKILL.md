---
name: verify
description: Verify Closing Time locally with automated checks, browser playtests, audit exports, and real Gemini inference in turn-based and real-time modes. Use after game changes, for playtest audits, or before a release.
---

# Verify Closing Time

Run all game checks against the local checkout. Read [the feature map](features/README.md) and the relevant feature files for the rendered journeys. Use synthetic dialogue and a disposable browser profile. Preserve existing browser data.

## Build and run automated checks

Work from the checkout root. Record `git rev-parse HEAD` and `git status --short`. Use Node 22.12+ and run `npm ci` if dependencies are absent.

```bash
git diff --check
npm run build
npm test
node .agents/skills/verify/scripts/verify.mjs "$PWD"
```

The bundled verifier checks five turn-based and three real-time scenarios with deterministic responses. It covers HTTP validation, legal actions, observation projection, and turn audit persistence, quota fallback, and failure handling. Keep its results separate from real Gemini results.

## Run real Gemini inference against the local game

Use `GEMINI_API_KEY` from the server process environment first. If it is unset or empty, let Node load it from `.env` in the checkout root. Never print, copy to a report, or commit the key, and do not source the file as shell code. If both sources lack a key, record Gemini checks as blocked and continue with the fixture checks.

Use port 4173 for the real local server. Confirm it is free before launch. Start the compiled app from the checkout root with the following command, which uses the same entry point as `npm start` and gives you the server PID directly.

```bash
if [ -z "${GEMINI_API_KEY:-}" ]; then unset GEMINI_API_KEY; fi
node --env-file-if-exists=.env scripts/serve.mjs &
GEMINI_PID=$!
```

Set `NODE_USE_ENV_PROXY=1` on the server launch when the environment requires an outbound proxy and the Node version supports it. Confirm the launched process owns port 4173 and wait for the root URL to serve the compiled page. Run the real inference checks with:

```bash
node .agents/skills/verify/scripts/verify.mjs "$PWD" --gemini
```

This calls the real app's local `/api/mara` endpoint. The five turn-based requests cover waiting, closing the window, picking up the papers, coordinating via speech, and asking about papers already held. The three real-time requests cover initial rain, the player having closed the window, and the player holding the papers and speaking while Mara is walking. Check response status, legal options, selected action, model and rationale, plus request/session identity and observation state in real-time mode. Record latency and any provider errors. A missing credential, timeout, or rate limit leaves the affected checks unverified.

Play both modes in the rendered browser at `http://127.0.0.1:4173/` and `http://127.0.0.1:4173/?mode=live` without fixture parameters. Confirm that the bare URL and an unknown mode start turn-based play. In turn-based play, take a turn and inspect **Turn audit**. In real-time play, move and speak while a request is pending if timing permits, then inspect **Scene audit** for a completed Gemini decision and its applied or skipped outcome. Download and inspect both trace formats. Match a real-time request's observation, model, selected action, rationale, and terminal outcome to the audit and resulting scene. Review whether Mara accounted for the player's actions and whether the rationale describes the selected action and actual effect. Accept any legal, contextually reasonable choice. Use the delayed fixture to verify concurrency when Gemini responds too quickly to observe it.

## Exercise timing, failure, and persistence in the browser

Start `node scripts/preview-fixture.mjs --port 4174` on a free port and keep its PID. Confirm the process owns the listening port and serves the game. Open `http://127.0.0.1:4174/?fixture=fixed&run=UNIQUE` in the browser. Check the title, controls, fixture panel, and initial room state. Use a unique alphanumeric run token for each journey.

- Follow the feature map for movement, Wait, speech, interactions, invalid input, failed turns, restart, and reload. Verify rain and player input while a response is held. Cover closing the window mid-route, picking up papers during inference, speech during movement, a blocked route, timeout, rate limiting, and a hidden tab. Pause, restart, or switch modes with an old response pending and confirm that it cannot affect a new session.
- Verify the v1 export across real-time play, restart, and reload. In the v2 export, check session, request, and action IDs, active time and model latency, pending and terminal outcomes, and the observed versus dispatch revisions. Reproduce a late close that is skipped after the player already closed the window. For fixtures, the preview endpoint can retrieve the JSON after the export button is clicked.

## Record evidence and clean up

Save commands, revision, server type, cases, screenshots or snapshots, and downloaded synthetic traces in a scratch directory. Report fixture checks, local Gemini endpoint checks, and local Gemini browser checks separately. Identify each failed or blocked entry point, including when the browser cannot expose a download. Keep evidence and credentials out of Git.

Close only the tabs or profiles created for the run. Stop each server by its recorded PID, wait for it to exit, and confirm the evidence is still readable.
