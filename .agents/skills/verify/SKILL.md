---
name: verify
description: Verify Closing Time's browser game, turn-based and real-time play, and audit exports using the compiled app and synthetic model fixture; use after game changes or for a playtest audit.
---

# Verify Closing Time

This skill is a draft until a browser-driven feature has been exercised end to end. Read `features/README.md` and the relevant feature files; report each entry point that was not exercised. The UI is the primary surface; `/api/mara` is the model endpoint. `README.md` documents setup, controls, and fixture scenarios.

## Launch

Work from the checkout root. Record `git rev-parse HEAD` and `git status --short`. Use Node 22.12+; run `npm ci` if needed, then `npm run build` and `npm test`. Tests use fixtures; they do not verify Gemini. Do not reset existing browser data or drive another person's instance.

For browser checks, use a disposable browser profile and an unused port. The fixture uses the real compiled client and worker but replaces Gemini; it never calls the provider. For example, after confirming port 4174 is free with `ss -ltn 'sport = :4174'`:

```bash
mkdir -p /workspace/scratch/closingtime-verify
node scripts/preview-fixture.mjs --port 4174 > /workspace/scratch/closingtime-verify/server.log 2>&1 &
VERIFY_PID=$!
```

Keep the shell session and `VERIFY_PID` for cleanup; choose another port if occupied. Open `http://127.0.0.1:4174/?fixture=fixed&run=YOUR_UNIQUE_RUN` in the browser on the same machine. Use a unique alphanumeric run token and an isolated profile: fixture counters are per run, while audit records are per browser origin. A fresh rendered game with controls and Turn 0 is ready; an HTTP response alone is not readiness.

## Doctor

Before interacting, check `kill -0 "$VERIFY_PID"`, verify the listening port belongs to the launched process (`ss -ltnp 'sport = :4174'`), and check `curl -fsS 'http://127.0.0.1:4174/?fixture=fixed&run=YOUR_UNIQUE_RUN'` returns the Closing Time page. In the browser confirm the URL, title, controls, fixture panel, and Turn 0. A failed check blocks the drive; do not use an unrelated server. Record the build revision and any dirty changes.

## Drive and evidence

Use an available supported browser automation surface to interact with the rendered game, using the labels and selectors in the feature map. Capture the action and resulting UI state as screenshots or browser snapshots under `/workspace/scratch/closingtime-verify/`, with the feature and run in filenames. Record commands, revision, fixture mode, outcomes, and failures in a text report there. Check side effects using the downloaded JSON; for fixture exports only, the fixture endpoint may retrieve the same JSON after the user clicks Export. Never treat fixture output as live model evidence. Use synthetic dialogue only and do not commit traces or credentials.

Live Gemini checks are separate and require a configured `GEMINI_API_KEY`, provider access, and authorization for model calls. Start the production server with `npm start` (in the current proxy-based cloud environment, `NODE_USE_ENV_PROXY=1 npm start`). Use a disposable browser profile and synthetic dialogue. Inspect Turn audit and verify the action, rationale, resulting state, and export. Do not print or save the key. Live responses vary; check legality and consistency rather than a particular action. Report live, fixture, and hosted results separately. The private Site may run a different revision; establish its revision separately before release claims.

## Cleanup

Close only the browser tab/profile created for this run. In the launch shell run `kill "$VERIFY_PID"` and `wait "$VERIFY_PID" 2>/dev/null || true`; verify the process has exited. Never kill by process name or delete another session's browser data. Keep `/workspace/scratch/closingtime-verify/` evidence after cleanup and confirm it remains readable.

## Helpers

The project supplies `node scripts/preview-fixture.mjs --port 4174`; see the README for scenarios and `features/` for UI journeys. No separate driver helper is bundled. If browser control is unavailable, report the blocked feature and keep this skill marked draft; HTTP or automated tests do not replace a browser proof.
