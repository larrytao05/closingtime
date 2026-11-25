# Closing Time design decisions

This log covers the existing game and decisions for the multi-character simulation. Entries marked proposed remain subject to implementation and review. The completed system-design document should describe the reviewed tree.

| ID | State | Decision | Reason |
|---|---|---|---|
| D01 | Existing | The world owns legal actions and outcomes. | Human and model inputs share object, distance, inventory, and occupancy rules. The model proposes a single action. |
| D02 | Existing | Turn-based play commits player action, model action, and rain together. Real-time play advances an independent clock. | The first mode is a controlled baseline. The live mode stays responsive while a request is pending. |
| D03 | Existing | Legacy audit schemas v1 and v2 are distinct. | A completed turn and a real-time session record different events. |
| D04 | Planned browser entry | Add a separate simulation mode with a three-character roster and an optional human. | The café can run without user input while the earlier modes remain available for regressions. |
| D05 | Reviewed | Put personality, local observation, and memory in each NPC decision. Keep the prompt free of an object directive or scene score. | Characters can develop their own responses to rain, dialogue, and shared objects. |
| D06 | Reviewed | Record speech recipients by perception at commit time. Schedule direct reply only for a witnessed addressee. | Other listeners can know what happened without all taking a fresh model turn. |
| D07 | Reviewed | Bound inference centrally and run it independently of room frames. Validate every choice against current state. | NPCs share a provider budget and the world changes while they think. |
| D08 | Reviewed | Use source-linked, per-actor memory. Store a claim as a claim and pin supported open commitments within the context budget. | Recent dialogue cannot carry every important promise. A character's report does not establish a world fact. |
| D09 | Reviewed | Save a versioned world, bounded trace, and memory in one browser record. Resume from committed state with fresh requests. | Cross-component partial writes would create mismatched memories, events, and world state. |
| D10 | Reviewed | Record the selected action, the dispatch outcome, and the model's short explanation in the simulation audit. Replay from committed state. | Audits can explain visible outcomes and verify them without relying on a fresh model response. |
| D11 | Approved | Use one shared contract and four parallel branches with separate writers. Integrate reviewed commits on a sixth branch. | Parallel work can proceed without racing on production files. Each review has an exact head and scope. |
| D12 | Reviewed | Publish open workstream PRs without merging or changing the deployed Site. | The user requested reviewable changes. Integration and deployment remain separate operations. |

## Decision evidence

- The previous phase's scratch comparison saw directed wake signals avoid unnecessary notifications on addressed speech and routine rain. An unresolved-commitment slot recovered a witnessed promise after incidental dialogue displaced it.
- The baseline at 671161c passed 42 tests. Local live Gemini verification remains contingent on a key present in the executor environment or the checkout's .env file.

- A local Chromium run on the baseline exercised a turn through the existing worker fixture, downloaded the v1 audit, opened real-time play, and downloaded its v2 timeline. The browser used the production origin check. The packaged browser's `--disable-web-security` flag was removed because it suppressed the Origin header.

- CT-S0 review rejected nullable action outcomes, unconditional saves, and an incomplete audit projection. Two fix commits made the room dispatch result explicit, specified atomic writer claims, set request and audit size limits, and kept the exact decision input in one nested request. The final review approved 5418ff5.

## Workstream review log

Each author pauses after committing a ticket or correction. A separate Luna reviewer inspects the pinned tree before it becomes a dependency. Repo integration follows the exact approved source trees. GitHub publication uses the service's commit identities and checks that the remote tree matches the locally reviewed tree.
- CT-O1 uses incremental byte accounting so an audit event does not remeasure the entire history. A later review required structural replay equality and complete validation of import payloads.
- CT-M1 reserves memory recall for unresolved commitments and attributes speech to the actor who said it. Review uncovered that the initial retention policy could still erase an unresolved commitment. The fix keeps it across ordinary event churn within a bounded store.
- The audit re-review approved c91de6c after replay equality became independent of JSON key order and import validation checked nested payload variants. The memory re-review approved 0ca7433 after the store protected unresolved commitments while enforcing its 512-record limit.
- The world review required bounded witnessed histories inside the room. The audit already owns a separate bounded history. The room now streams every commit to subscribers and keeps only the recent actor-local view needed to request a decision.
- The decision scheduler uses a positive fallback when a rate-limit response omits its retry delay. The worker records a provider response ID only when Gemini supplies one. Provider model version and response identity are different fields.
- Cross-workstream testing with a real monotonic clock found that audit and model parsers required integer timestamps. Active time and elapsed exposure are continuous milliseconds. Revisions, event sequences, and tile coordinates retain integer validation.
- Memory proposals need a stable source reference that Gemini actually sees. The provider projection must include the visible event's reference while still withholding authoritative checkpoints and unwitnessed data.
- The recall algorithm uses incremental UTF-8 byte accounting. Built JSON records and IDs keep their previous order and byte bound. A Unicode boundary test verifies inclusion at the exact limit.
- The audit serializer can use internally owned state directly during synchronous export. Public snapshots stay isolated. Replay validates imported data once and copies only the last committed checkpoint needed to return the final state.
- In an in-process Node probe with a fractional monotonic clock, five 1,000-event trials retained 512 memory records. Median p95 actor projection was 0.91 ms and median p95 projection plus recall was 4.37 ms. Median export was 17.75 ms and median JSON parse plus replay was 29.80 ms. The slowest runs were 1.17 ms, 6.31 ms, 24.47 ms, and 39.87 ms respectively. This probe excludes rendering and network latency.
- The integrated runtime worker fixture accepted a fractional-time request and recovered a source-grounded memory through the provider alias and canonical event ID.
- Runtime reset marks the generation stale and cancels active requests before awaiting the durable checkpoint. A held-save regression verifies that a provider reply cannot mutate an old run once reset starts.
- Only terminal decision records are written into the durable snapshot. Browser shutdown or interruption can drop the current in-flight request rather than recording a fabricated result. A pause or explicit reset terminalizes local cancellations before checkpointing.

## CT-I2 browser decisions and evidence

- The simulation uses a separate `SimulationView` with a lightweight canvas renderer over the room checkpoint and frame subscription. This keeps the legacy Phaser mode and public audit formats intact while reusing the shared runtime, room, movement, options, and save contracts.
- Simulation mode remains spectator-first. New and Resume are explicit actions, so loading a fixture URL or reloading a saved scene does not silently replace the current run. The opening scene wakes Mara once; fixture URLs use a 4-second ambient interval so a local observer can see autonomous turns promptly.
- Addressed speech is selected in the player form and remains subject to the room's visibility and hearing rules. Text from speech, audit, inspector, and replay enters the DOM through `textContent`.
- Audit import is a read-only preview of the replayed final checkpoint. It does not install the imported run as the current save or send provider requests.
- The preview fixture now recognizes `mode=simulation` as a fixture request, exercises the built worker's `/api/simulation` parser, selects an addressed NPC speech option, returns an NPC reply, and cites an observed speech with the worker's `evidence-N` alias for a commitment proposal. It can capture schema-v3 downloads. Fixture behavior is synthetic and is not evidence of actual inference quality.
- UI and worker implementation have been built locally. Browser verification and the separate independent review are pending. The local environment has no configured Gemini key; real Gemini latency, behavioral checks, and two-minute spectator runs remain unresolved.
