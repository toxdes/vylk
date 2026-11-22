# Implementing a VYLK client

The [OpenAPI specification](openapi.json) describes every backend API route.
This guide explains the stateful protocols that individual route schemas cannot
express. Serve requests from your instance's base URL, not the documentation site.
The API is currently unversioned; pin your client to a tested VYLK release and
ignore additional response fields. Do not send unknown request fields.

## Transport and authentication

Use HTTPS for remote access. Plain HTTP exposes passwords, proofs, cookies, and
plaintext notes. Browsers need a secure context for E2EE: HTTPS remotely or HTTP
on localhost/loopback. Native cryptographic libraries do not have that browser
restriction, but HTTP still exposes reusable authentication secrets.

Read `GET /api/vault/bootstrap` without HTTP caching and compare its `instance_id`
before accessing cached notes or remembered keys. Keep the cache identity readable
even when its note data is encrypted. A different identity requires an explicit
choice: retain local data while restoring the previous database and notes directory,
or discard it and switch. A network failure is not a changed identity. Coordinate
the choice across tabs and fence stale writes during an atomic local reset. Keep
the switching page's callbacks bound to the old identity until it reloads; clearing
the cache must not authorize old editor saves against the replacement database.
Retain the application/service-worker cache; it contains no account or note data.

Then log in using the configured password for
`legacy`/`preparing`, or a derived proof for `encrypted`/`cleaning`. Retain the
`session` and `vylk-device` cookies. There is no Bearer token, API key, CORS API,
or per-user account identifier. This is one person's instance, not a shared
multi-user notes service. A native client's cookie jar represents its device.
The sync queue's `device_id` is a separate identifier, not an authentication token.

JSON responses use `application/json; charset=utf-8`. Send JSON request bodies
with `Content-Type: application/json`. Errors normally contain `error` and
`code`; inspect the code rather than English text. Router-generated 404/405
and SSE setup failures can be plain text. Session renewal can add `Set-Cookie`
to authenticated responses, not just login. Preserve each cookie header.

VYLK also sends `X-Content-Type-Options: nosniff`,
`Referrer-Policy: same-origin`, and its app-oriented `Content-Security-Policy`
on all responses. Its own gzip middleware excludes `/api/` routes; a reverse
proxy can still compress them or add headers. Do not require transport headers
to match a hardcoded set. SSE additionally sends `Cache-Control: no-cache` and
`X-Accel-Buffering: no`. Bootstrap sends `Cache-Control: no-store`; other JSON API
responses do not set an application cache TTL.

On 401, stop background sync and request sign-in without deleting pending edits.
Respect `Retry-After` on 429 and use bounded backoff for transient network/5xx
failures. A timeout does not prove that a write failed. Never log credentials,
proofs, session cookies, recovery words, keys, or decrypted note payloads.

## Notes, revisions, and preferences

Saves carry complete Markdown and metadata, not textual deltas. Updating a note
requires its known `base_revision`; new client-generated IDs use 0. Direct saves
return metadata without the body. Tags are a comma-separated string, not an
array. Revisions and sequences are signed 64-bit integers; languages with
limited numeric precision must handle them without silently rounding.

Direct `PATCH /api/prefs` is full replacement despite the HTTP method. Read the
complete object, merge desired changes locally, and use its revision in
`If-Match`. Missing fields can reset settings. For queued field-level changes,
use `prefs.save` with `_sync_patch` (desired fields), `_sync_base` (previous field
values), and `base_revision`. A stale patch conflicts when another device changed
one of those fields to a value different from both the base and desired value.
Preferences are not encrypted and are not in the note change feed; refresh them
on preference hints and reconnect.

## Durable synchronization

Persist server `instance_id`, vault identity/epoch, pull cursor, queue identifier,
next client sequence, pending full-note operations, and acknowledgements together
with the local cache. Coordinate a single queue owner when multiple app windows
share that store; an active/focused window is not a reliable ownership lock.

For initial state, obtain a feed baseline before listing all note-summary pages,
fetch complete notes in batches of up to 25, then replay changes after that
baseline. There is no atomic multi-request snapshot. A fetched note can already
contain a newer revision than its feed entry. Use revisions, deduplicate IDs,
apply deletion tombstones, and never replace an unresolved local edit with a
remote snapshot silently. Commit cache changes before advancing the cursor.

Pull with `since` exclusive and follow `hasMore`. Stop the loop when `hasMore`
is false; a nonzero cursor is not a reason to fetch forever. SSE is only a hint:
events can be coalesced or lost and have no replay IDs. Pull after reconnect
even if no change event arrived. When `resetRequired` is true, the retained
feed cannot cover your cursor. Use the returned newest cursor as a baseline,
rebuild the remote snapshot, and replay changes after it; retain pending edits
separately throughout this process.

Push at most 100 ordered operations. `client_sequence` starts at 1 and advances
contiguously per queue `device_id`. `op_id` identifies an operation across
retries. Persist both before sending; retries must keep the same payload and
identifiers. An empty push returns `expected_sequence`. A previously used ID
is not a fresh queue: inspect the server counter before scheduling operations.

Inspect every acknowledgement, even on HTTP 200. `conflict` consumes its sequence
and needs explicit client-side reconciliation followed by a new operation.
`compacted` acknowledges a consumed sequence whose detailed result was pruned;
it does not prove the desired note content is still on the server. A sequence
gap returns 409 and can still acknowledge an applied prefix. Timeouts and 5xx
can follow partial commits too. Retain and retry identical unresolved operations;
the batch is not an all-or-nothing transaction. Use `noop` for a deliberately
canceled queue slot, not to conceal an unresolved conflict.

Include `X-Vylk-Instance-ID` on every push and compare identity on every check
and pull. With a replacement database, pause before uploading or clearing
anything. If there are pending edits, offer to retain them while restoring the
original database and notes directory, or explicitly discard them. Never silently
renumber and replay them into a different server. A cursor beyond the new feed's
head does not necessarily produce `resetRequired`; identity is essential.
Matching identity does not detect restoration of an older snapshot of the same
database; the protocol does not guarantee server rollback detection.

## Encryption wire format

All binary values use strict, unpadded base64url. The vault ID and Argon2 salt
decode to 16 bytes; login and recovery proofs decode to 32 bytes. JSON envelopes
are objects: `{"v":1,"nonce":"...","ciphertext":"..."}`. AES-256-GCM uses
a fresh random 12-byte nonce for every encryption, a 128-bit authentication tag,
and ciphertext with that 16-byte tag appended. Never reuse a nonce under a key.

Derive a 32-byte root from the exact UTF-8 password using libsodium-compatible
`crypto_pwhash`, algorithm `ARGON2ID13`. Use bootstrap `iterations` as opslimit
and `memoryKiB * 1024` as memlimit; do not normalize password Unicode or
substitute a generic library's default Argon2 parameters. New setup uses 19,456
KiB and 2 iterations; the server accepts 19,456–262,144 KiB and 2–10 iterations.
For compatibility with the browser client, limit passwords to 1,024 UTF-16
code units; its KDF worker rejects longer strings.

Derive subkeys with HKDF-SHA-256: input key material is the root, salt is the
decoded 16-byte vault ID, info is the UTF-8 label below, output is 32 bytes.
From the password root, labels are `vylk/v1/login` (proof) and `vylk/v1/wrap`
(AES wrapping key). Send the original proof bytes encoded in base64url, not
their SHA-256 hash; the server stores that hash itself.

Recovery uses 32 random entropy bytes encoded as a 24-word BIP39 English
mnemonic. Decode words back to the entropy, NOT the BIP39 PBKDF-derived seed.
Use that entropy as the HKDF root with labels `vylk/v1/recovery-login` and
`vylk/v1/recovery-wrap`. Earlier clients also accepted the 43-character base64url
entropy representation; new clients should present the numbered mnemonic.

Generate a separate random 32-byte vault key. Both wrappers encrypt that same
key. Their AES additional authenticated data (AAD) is compact UTF-8 JSON:
`["vylk",1,"<vault-id>","vault-key"]`. Use the original base64url ID string.
The recovery wrapper uses the recovery wrapping key, not the password key.

Derive note AES keys from the vault-key root using HKDF labels `vylk/v1/summary`
and `vylk/v1/body`. Summary plaintext is UTF-8 JSON with string `title` and
comma-separated string `tags`; body plaintext is UTF-8 Markdown. AAD is compact
JSON `["vylk",1,"<vault-id>","<note-id>","summary",<epoch>]` or the same
array with `"body"`. There must be no whitespace in the encoded AAD,
and epoch is a JSON integer, not a string.
The browser additionally uses `vylk/v1/local` for its encrypted offline cache;
native clients can use a separately designed protected local storage format.

Send `X-Vylk-Vault-Protocol: 1` on note/search/tag/sync routes in encrypted mode.
Auth, keys, preferences, migration, and SSE do not require that header.
Encrypted saves contain `summary`, `body`, and `epoch`, never plaintext fields.
Search and tag filtering happen locally after decryption. On stale epoch, stop
and refresh bootstrap/keys; never relabel old ciphertext with a new epoch.

## Enabling encryption and resuming migration

Drain or explicitly reconcile pending plaintext edits first. Start migration
with the server password, generated vault ID, KDF parameters, both proofs, and
both wrappers. Preserve those generated secrets across retries. `preparing`
keeps plaintext readable but blocks note writes. A repeated start with the same
ID resumes existing setup rather than changing its stored credentials.

Read migration `next` pages, fetch each source note, encrypt at its source
revision, and `stage` it. Download `staged/{id}`, decrypt summary/body, and
compare against the original before `verify`. Use the returned `body_hash`:
it hashes exact stored envelope JSON bytes, not reserialized JSON or plaintext.
Restaging clears verification. Commit only after all notes are verified.

Commit revokes sessions and removes plaintext storage/indexes/old sync payloads.
Log in with the new proof. Queue counters survive this migration; do not reset
an existing queue's sequence to 1. A `vault_cleanup_pending` 500 means cutover
already committed and server restart resumes cleanup. Do not restart setup or
resume plaintext writes in that state. There is no migration abort endpoint.

## Credentials, reset, and security limits

Changing password or recovery key rewraps the existing vault key. It does not
rotate that key or prevent an already-unlocked offline device from reading its
cache. `sign_out_other_devices` defaults to true; current session is always
revoked. The next login must derive against fresh bootstrap settings.

The reset API creates a NEW EMPTY vault using `VYLK_PASSWORD`, when configured.
It cannot decrypt the old notes. Old ciphertext and database are quarantined
for 30 days, but still require the old key. Confirm irreversible access-loss
consequences; do not automatically retry an ambiguous reset. Vault ID changes,
epoch increments, server instance ID stays the same, and queue counters reset.

`VYLK_DISABLE_VAULT_CHANGES=true` rejects setup, credential changes, migration
mutations, reset, and device revocation at the API. It does not disable normal
notes, existing vault reads/writes, preferences, or the client's own logout.

E2EE hides titles, tags, bodies, and properly encrypted local pending edits, not
IDs, timestamps, pins, preferences, sizes, or traffic patterns. It does not
prevent a compromised server from distributing a modified browser app that
steals keys. The protocol does not provide general ciphertext rollback
detection. Back up the database and notes directory together.

## BYOK AI

AI is disabled by default through the synchronized `aiEnabled` preference. All
`/api/ai/` routes require an authenticated session and enabled AI; disabled routes
return `403 ai_disabled`. Disable cancels provider calls and discards temporary
sessions. Configuration and usage rows remain in SQLite. AI emits `ai` change hints
over the existing event stream; clients should refresh configuration metadata.

`GET /api/ai/configurations` returns an array of `{id, name, url, model, has_key,
checked, is_default, revision}`. Saved API keys are never returned. Create with
`POST` and update with `PUT /api/ai/configurations/{id}` using `{name, url, model,
key?, revision}`; revision is required for updates. Omit key to retain it, or send
an empty key to remove it. The model ID is forwarded unchanged. URL is the API
base, such as `https://openrouter.ai/api/v1`, rather than a completion URL.
HTTP and HTTPS are supported, including local/LAN endpoints. Redirects are not
followed. API keys are stored directly in SQLite and its backups.

The preferences form tests before saving: `POST /api/ai/configurations/test`
accepts `{name?, url, model, key?, id?, revision?}` without storing a configuration.
For edits, omit key to test the saved key. A successful test returns `{ok: true,
test_token, reported_context_tokens, default_context_tokens}`.
`reported_context_tokens` is the provider-reported window, or 0 when the provider
reports none; the form prefills `context_tokens` from it or from the default.
Pass the token with the configuration save to store it as checked.
The receipt expires after ten minutes, can be saved once, and is bound to the
authenticating session and exact endpoint/key/model/identity/revision. Changing
those fields requires another Test; changing only the name does not. Test usage
is recorded even if the draft is cancelled. The original unchecked-create and
saved-configuration Check interfaces remain available to existing API clients.

`POST /api/ai/configurations/{id}/check` makes one small generation request and
records usage. Check may consume tokens. URL/key/model edits invalidate the check.
The first successful configuration becomes default; later changes require
`POST /api/ai/configurations/{id}/default`. Deleting a default with `DELETE` does
not select another provider. Configuration changes cancel affected sessions.

Create a session with `POST /api/ai/sessions` and `{note_id, scope, text}`. Scope
is `none`, `selection`, or `note`; text must be empty for none. An empty selection
is an insertion point. Share only the selected Markdown, or the whole body when
explicitly authorized. Never include unshared surrounding text, titles, tags,
or vault keys. For encrypted notes this intentionally sends decrypted context
through the server to the provider; disclose that before submission.

Session responses contain `{id, note_id, scope, draft, hunks, answer, version,
can_undo, changed, job?}`. Hunks contain `{id, ref, start, end, before, after, decision}`;
start/end count UTF-16 code units in the current shared draft. Decisions are
empty, `accepted`, or `rejected`. Lock note editing while the session is open.

Send `{prompt, version, thinking?, whole_context?}` to `POST /api/ai/sessions/{id}/plan`. Planning is
non-billable and returns `{id, version, sections, estimated_input_tokens}`. A
plan freezes the accepted draft and request. The editor starts the planned job directly after Send. Section counts and
provider-call orchestration are backend details; the UI uses the same Working
indicator, replies, review, and explicit retry action for every request.
Jobs read the shared text in one of three ways. A plan that fits one request
sends it whole. A plan with several sections first makes one routing request
that contains the request, text statistics and section count, but no shared
text. The model then answers directly, uses tools, or chooses a route:
`edit_sections` (parallel section edits), `read_whole` (one request with the
whole text, offered only when it fits), or `combine` (each section reports
findings, oversized findings merge in batches, then one request answers).
Revisions of existing suggestions and scope `none` skip routing and tools.

Read-only tools run only on the turn's frozen shared text, never on unshared
note content: `search` (RE2 pattern; exact count plus the first 20 matches with
byte offsets), `read` (byte range, at most 16 KiB), `outline` (ATX headings) and
`stats`. Each request lists `tools_available`, `tool_rounds_remaining` and
`max_tools_per_round` (8). A turn allows 8 tool rounds of at most 8 calls, and at
most 32 KiB of results per round, bounded further by the remaining context
window. Routes spend no round. Tool requests and results stay within the turn;
conversation history keeps only the final answer. `completed` and `total` count
provider calls and can grow while routing proceeds.
Send `{plan_id, version}` to `POST /api/ai/sessions/{id}/start`; it returns HTTP
202 with `{id, snapshot_id, version, status, completed, total, error?}`.
Use `GET /api/ai/sessions/{id}?job=1&wait=1` to wait up to 25 seconds for
completion, then repeat if still running. It returns immediately when results
are ready, removing the periodic polling delay and reducing control requests.
At most two waiters per job are allowed; aborted waits release their resources.
Omit `wait=1` for an immediate status response. Fetch the session once status is
`completed`. The editor shows a compact elapsed time after success, such as
`Took 2.3s` or `Took 2m 10s`; it measures the whole attempt including setup and
transport, and retries start a fresh measurement. States are `running`, `completed`,
`failed`, or `cancelled`. `POST /api/ai/sessions/{id}/cancel` with `{}` revokes
pending plans, in-flight planning, and the running job but keeps the session. Browser disconnection alone does not
cancel a background job; closing AI sends DELETE. Keep controls locked until
cancellation is acknowledged. `POST .../turn` remains a synchronous single-call
compatibility path; use planning/jobs for the editor.

The backend owns the system prompt and conversation. Results arrive complete after validation;
there is no token streaming to the client. Normal editing requests allow up to two bounded
model corrections after a finished reply fails JSON or local output validation. Provider input contains
ordered `blocks: [{id, text}]` from the frozen editable range, without duplicating the
note in a `current_scope` field. Each top-level Markdown block is an independent edit unit; unrelated short
paragraphs are never grouped together. Lists, fences, tables and nested containers
remain intact within their assigned context section. The provider still receives
multiple blocks together; context chunk sizes and request counts do not change. IDs bind to the draft version
and source position; they are separate from the user-facing `@1` proposal labels.
The provider returns exactly
`{"answer":"brief reply","changes":[{"id":"current block ID","before":"exact unique text","after":"replacement"}]}`.
Only changed spans are returned, at most 4,096 per call; questions use `changes: []`.
`before` must match exactly once inside the identified frozen block. Several edits
may share an ID, but all anchors refer to that same original block and must not
overlap. Include adjacent unchanged words only to disambiguate, retaining them in
`after`; do not reproduce a whole paragraph for a small correction. Empty `before`
is allowed only for one insertion into an empty target. Nonempty targets require
an adjacent unique anchor for insertion. Empty `after` deletes its anchored span.

For pending suggestion follow-ups, `mode: "revise_suggestions"` exposes only the
proposed wording in `blocks`, using editable `@` IDs. `originals_read_only` retains
the original wording for withdrawal; out-of-range proposals appear only in
`read_only_references`. Reference metadata does not duplicate pending before/after
text, and previous review hunks are omitted. Native JSON schemas constrain IDs to
all supplied editable targets, including ordinary frozen block IDs (or require an empty changes array when none are editable).
Correction attempts retain the same targets and constraints.

Go validates every anchor before reconstructing changed blocks and computing the
existing review hunks locally. Unchanged text stays in the frozen snapshot rather
than being regenerated by the model. Original outer ASCII whitespace (spaces,
tabs, CR and LF) belongs to the application and is restored per block; internal
Markdown and whitespace remain editable. Whole-block anchors still express broad
rewrites using the same contract. Unknown, stale or out-of-range IDs, missing or
ambiguous anchors, duplicate/overlapping edits and malformed text fail before
publication. JSON fences and the previous `{id,text}` whole-block response shape
remain errors; there is no alternate-format parser or heuristic repair.
For a finished invalid reply, the backend may make up to two additional model calls with
`validation_feedback` containing the validation error and previous response. The
original request, block IDs, references, snapshot and cancellation scope stay fixed.
Anchor failures include `anchor_error: {change_index, id, before}` identifying the
rejected edit by its zero-based index in the previous `changes` array. For a missing
anchor, `matching_block_id` is included only if that exact text occurs once across
the current request's editable blocks, in a different block. Read-only text and
other sections never supply hints. Hints are diagnostic: the model must return a
corrected complete response, and the application never relocates edits itself.
The feedback is data, not a replacement user instruction. The corrected complete
reply must pass the same strict validation before publication. If correction fails
or cannot fit the context budget, no new suggestions are published and a manual
retry remains available. After exhausted automatic corrections, the UI shows a plain-language failure without schema or anchor internals; technical causes remain in `validation_failed` debug events. Every actual call has its own usage row, including failed
output and the correction, with the same turn ID. Transport, HTTP/provider, timeout,
cancellation and accounting failures do not trigger this correction. Configuration
Test/Check keeps its single request and 2,048-token budget.
Line diff work is capped at one million cells (about 2 MiB of table storage);
larger or highly fragmented changes become one focused replacement. This avoids
unbounded quadratic work. Changes stay inside the shared scope. Prompt-only
requests cannot produce note edits. Failed attempts do not become conversation
history. Section planning uses CommonMark/GFM block positions, preserving fences,
tables, blockquotes, nested list items, line endings, and exact byte coverage.
Top-level list items may be separated. Oversized indivisible blocks are rejected
before dispatch. Neighbouring text (up to 768 bytes on either side) is read-only
and remains inside the chosen sharing scope. Workers have disjoint editable
ranges against one immutable snapshot. Every section must finish and validate
before any suggestions are published. A failed section cancels remaining work;
previously dispatched calls may still consume tokens. Only the bounded output-validation
correction above can generate an additional automatic provider call.
Snapshot/version and turn-lease checks prevent late cancelled results from
modifying another query. Reviews and follow-ups cannot change a running snapshot.

Normal requests to OpenRouter use provider-side SSE streaming internally. The
backend assembles and validates the complete JSON answer before returning any
review hunks; a stream completion marker and finished response are required.
Other compatible endpoints keep their non-streaming request format, and SSE
responses are also understood. Streaming usage frames are retained for accounting.
SSE transport has a separate 32 MiB work budget because per-chunk envelopes and
reasoning can be much larger than the answer. Reasoning is consumed without
retaining it as answer text; assembled answers remain limited to 256 KiB. Debug
capture retains at most the first 64 KiB of a stream and reports `omitted_bytes`;
the complete assembled answer is logged separately as `answer` after a finished
response. Neither budget changes the provider's output-token setting.

Successful configuration Test/Check refreshes capacity metadata after its single
completion, so a local model loaded by the test can report its active window.
Before a turn, uncached capacity metadata is also discovered without generation.
Metadata has a two-second deadline, a 2 MiB response bound, a 15-minute cache and
a 64-entry cap, scoped to URL/model/credentials. OpenRouter uses its per-model
endpoint metadata and conservatively takes the smallest known advertised context
and completion limits across endpoints. Other compatible endpoints use `/models`
when available, reading selected-model `context_length`/`max_model_len` and
`max_output_tokens`/`max_completion_tokens` (including `top_provider` limits).

For Ollama servers identified by their existing `/api/show` metadata, discovery
supplements the compatible catalog with read-only `/api/ps`, preserving the
configured origin, authentication and proxy prefix. Only the selected model's
active context is considered. Explicit model `num_ctx` and positive `num_predict`
parameters also constrain planning. The architecture's maximum context length is
an upper bound, never a substitute for an unknown active/configured window.
No metadata lookup loads a model, changes server options or sends note text.
Generation continues through the configured OpenAI-compatible chat endpoint.

Planning checks the complete serialized prompt, history, read-only neighbours,
review references and editable blocks, reserving conservative space for whole-block rewrites (both anchors and replacements),
JSON overhead and expansion headroom. Small corrections normally return far less text. Known context/output limits
can shrink sections before any generation, while Markdown units remain atomic.
If a whole passage or fixed conversation cannot fit safely, planning fails before
sending text; it never silently truncates the note or history. These are token
estimates, not a tokenizer or a guarantee of fit. Unavailable capacity stays
unknown and retains existing bounded section defaults. Neither metadata nor the
planner caps normal generation output, and arbitrary expansion or long reasoning
can still exhaust provider limits.

Each review hunk has a stable human-readable `ref` (`@1`, `@2`, `@2.1`, …), separate
from its internal ID. Labels are allocated in note order when validated results
are published and are never renumbered or reused within the session.
New diffs consume root numbers. Revising `@5` allocates `@5.1`, then `@5.2`,
and so on within that root; revising a child continues this sequence rather than
adding another dot. If one revision produces several separate diffs, each gets
the next suffix in note order. Suffixes identify revised diffs, not request counts.
Full tags refer to exact historical versions; `@5` never aliases the latest child
or the whole family. The provider uses only existing editable tags; new tags are
assigned by the server after validation. Current
labels persist across answer-only turns and review actions. Follow-up prompts
resolve explicit labels on the server into original proposal text and its
pending/accepted/rejected/withdrawn/superseded/undone status. Unknown labels fail before
provider dispatch. Superseded labels must not silently refer to newer changes.
Historical tags are informational only, including accepted and rejected tags. Their
wording is never searched in the current draft to recover a position. Select the
current passage explicitly for a new edit.
Archived proposal payloads have a 512 KiB bound; status metadata is retained for
up to 10,240 labels. Unavailable historical details produce a clear explanation,
not guessed edits. Referenced payloads are limited to 128 KiB per request.
A follow-up mentioning labels is routed only to relevant context ranges; historical
questions use one context range. Spans crossing a normal planning boundary remain
whole, with normal context preflight checks. Pending revisions return the same compact
change shape with `id: "@3"`; its `before` anchors match the pending proposal's
current **after** text, and `after` supplies the replacement for that anchor. Only explicitly referenced, currently pending,
editable @IDs are allowed. Starting from the existing proposed after text preserves
other improvements. Replacing the proposal's complete current after text with its
exact original before text withdraws that suggestion if no change remains. Questions return `changes: []` and preserve all pending proposals.
Revising a pending proposal supersedes its old label and allocates new labels; withdrawing
it records `withdrawn`. Unrelated pending labels and text remain intact. Failed revisions
publish nothing. For accepted/rejected/withdrawn references, current block IDs can make
new proposals when their original text is still uniquely identifiable. References never
authorize edits outside shared scope or acceptance of a note edit; applying proposals
still requires the explicit review controls.
The editor highlights changed words within diff lines with bounded, cached
intraline comparisons; larger changes fall back to a focused highlight.

Send `{action, hunk_id?, version}` to `POST /api/ai/sessions/{id}/review`, with
action `accept`, `reject`, `accept_all`, `undo`, or `finalize`. Review stages edits
without writing notes. Follow-ups use the accepted working draft and replace
pending proposals only when they produce new edits. Answer-only replies preserve
unreviewed suggestions. Undo reverses the last acceptance (Accept all is one action)
and invalidates pending suggestions. Finalize requires every hunk to be reviewed
and returns the draft without changing it; it is retry-safe for a given version.
The editor saves each accepted change, Accept all, and undo immediately through
the normal local/encrypted sync flow, then keeps the session open for follow-ups.
Before each save, verify the captured document identity, version, and current
content; advance that baseline and the shared selection range after a successful
save. Failed local saves retain the reviewed draft for retry and block further
changes until saved. A context chip opens the shared selection or note in a dialog;
the sidebar contains conversation and progress; diffs and review controls appear
in the editor alongside unchanged source text. AI is available only in the regular editor,
not Zen mode. Never directly write plaintext server notes from AI.

`GET /api/ai/sessions/{id}` reads the current draft after an ambiguous response;
`DELETE` cancels and discards it. Sessions belong to their authenticating cookie,
expire after 30 idle minutes, and disappear on server restart. Closing, logging
out, disabling AI, changing notes/views, or a remote deletion of the note must
invalidate the editor session. A remote edit of the note body keeps the session
and conversation: send the new shared text to `POST /api/ai/sessions/{id}/rebase`
with `{version, text}`. The server compares it with its draft as one changed
span. Pending suggestions before or after the span move with it; suggestions
it touches become `outdated` (offsets 0), can be dismissed with `reject`, and can
never be accepted. Rebase clears undo and requires no running job, so clients
apply remote edits after the current request finishes. Title and tag edits do
not affect AI, which never shares them. If a remote edit lands while an accepted
change is being saved, keep both when they touch different text; otherwise ask
the user to undo the accepted change. Accepted changes save locally first, then
sync in the background. A sync conflict on the open note keeps the session: the
editor shows the remote text and rebases onto it, the resolver keeps the local
version including accepted changes, and saving a resolution rebases again. By default, no prompts, replies, or shared text
are persisted; temporary debug logging is an explicit exception described below.
Same-content sync acknowledgements update the note-save revision fence without
cancelling AI. A new unsaved note being absent from a remote snapshot is not a
remote deletion.

Limits: 32 configurations, four open sessions, 1 MiB frozen/shared text, at most
64 sections and 512 combined hunks, 64 KiB of combined section explanations,
20 turns, 16 KiB prompts, and 256 KiB per
provider reply. Planning uses the configuration's `context_tokens`, else the
provider-reported window, else 32,768 tokens. Notes up to about 4,096 estimated
tokens use one request. Larger notes split into about one section per parallel
request, between 4,096 and 12,288 estimated tokens and at most 48 KiB per section.
Requests that revise existing suggestions use sections of about 2,000 tokens so
unrelated text stays out of them. Smaller
context/output limits, reply byte bounds and change-count limits can
reduce sections; the section
count may reject a note below the snapshot ceiling. Planning is serialized and
rejects more than 32,768 lines, oversized lines, or extreme quote nesting before
constructing its block-only AST. Provider calls have a ten-minute deadline and
jobs a one-hour overall bound. `VYLK_AI_CONCURRENCY` defaults to 4, accepts 1–8,
and bounds generation across all jobs and Test/Check requests in this instance.
A configuration's `concurrency` (1–8, 0 for the server value) sets its parallel
section requests, capped by `VYLK_AI_CONCURRENCY`.
Increasing it raises peak provider work, memory, network traffic and potential
cost. Normal turns omit an output-token limit, leaving it to the provider;
Test/Check retains a 2,048-token output limit and requires complete valid JSON.
Conversation history is compact and bounded; the accepted draft and relevant
previous proposals remain authoritative context. Combined review/undo storage
has separate 2 MiB limits, with at most 128 undo actions. Limits produce errors
rather than silently truncating editable text. Completion waits use bounded
25-second control requests; synchronous compatibility clients need a transport deadline longer
than ten minutes (610 seconds).
Provider deadlines are reported as timeouts, separately from session/browser
cancellation, and usage outcomes distinguish `timeout` from `cancelled`.

For temporary provider debugging, start the server with `VYLK_AI_DEBUG=1`.
`ai_debug` JSON entries go to server stderr, correlating request bodies, response
status/content type, provider generation ID when returned, raw response bodies,
and transport/validation results by request
ID and elapsed milliseconds. Final `result` entries include `timings` with
`queue_wait_ms` for waiting on the app's provider slot, `headers_ms`, and, for SSE, `first_reasoning_ms` and `first_content_ms` when
observed. Normal generation entries also carry `turn_id` and a one-based `attempt`
(first call or automatic correction), allowing request counts to be grouped by turn.
When the provider supplies its OpenAI-compatible `timings` extension, result entries
include `timings.inference`: `prompt_ms`, `predicted_ms`, `prompt_n`, `predicted_n`,
`cache_n`, `prompt_per_second` and `predicted_per_second`. Rates use tokens/second;
when omitted, they are derived only from valid matching counts and positive
millisecond durations. Missing metrics stay omitted, reported zero stays zero,
and unusable telemetry never rejects a valid answer. Counts retain native provider
semantics and do not replace standard usage/accounting. Timings are captured from
both nonstreamed replies and streaming metadata events without extra API calls.
For nonstreamed responses, `headers_ms` may include inference wait; it is not a
network-only measurement. `first_reasoning` and `first_content` events are also emitted as they
arrive. Stream metadata records the resolved `model` and `provider` when present,
which is useful when a router chooses them dynamically. Final entries also
include the provider's reported token `usage`, including
reasoning tokens when available. These distinguish waiting for meaningful
output from reasoning and answer generation without treating wire bytes as
tokens. Non-streaming responses cannot expose first-token timing.
`body_progress` reports cumulative received and
non-whitespace bytes on the first read, first non-whitespace content, and at most
once per ten seconds of subsequent reads. It logs no partial chunk content.
Silence after headers means no bytes were observed yet; whitespace-only progress
may indicate provider keepalives. No background polling is added.
Headers and cookies are omitted; the configured API
key is redacted if reflected in a body or error. Logs contain shared note text,
prompts, answers, and any returned reasoning. Debug output stops after a 16 MiB
payload budget per process. Unset the variable and restart to disable it. Normal
operation does not log these bodies.

Every dispatched Test, Check, turn, or section creates an `ai_usage` record with provider/model,
note/session/query attribution (sections share a turn ID), timestamps, outcome, latency, and reported input,
output, total, cached, and reasoning token counts. Unreported counts stay NULL;
cancelled/failed requests may still have incurred provider usage. Historical rows
survive note/configuration deletion. No usage-statistics UI is included yet.

AI thinking controls are discovered during configuration Test/Check using OpenRouter's
model catalog or Ollama's model metadata, with no additional generation. A bounded 15-minute, 64-entry cache
holds capability metadata; it is rediscovered after restart. For compatible base URLs ending
in `/v1`, the backend probes the sibling `/api/show` endpoint with only the selected
model name (a metadata POST), preserving the origin, authentication and reverse-proxy
prefix. The lookup has a two-second deadline and a 2 MiB response bound.
Unknown compatible APIs,
dynamic routers (`openrouter/free`, `openrouter/auto`), unavailable metadata, and
mandatory-thinking models are not controllable. The catalog must explicitly advertise
optional reasoning and support for the `reasoning` parameter. Ollama must explicitly
advertise both an off value (`false` or `"none"`) and an on value in
`thinking.values`. For imported Qwen3.5 GGUFs without that newer metadata, the
combination of the server-reported `details.family="qwen35"` and `thinking`
capability identifies the family's supported boolean control. Model-name matching
is never used, and explicit newer metadata always takes precedence. Other models
without sufficient metadata and level-only models without an off value keep the
checkbox hidden.

`GET /api/ai/capabilities` returns `thinking_controllable` for the checked default
configuration when opening the sidebar. Sessions independently freeze and return that
capability. Show **Use thinking (slower)** only when true, unchecked initially.
The plan/legacy turn request accepts `thinking` (boolean, default false). The backend
rejects true for uncontrollable sessions. For controllable OpenRouter models, it sends
`reasoning.enabled` explicitly. For controllable Ollama models, it sends
`reasoning_effort: "none"` when unchecked; when checked it sends `"medium"` for
boolean controls or an advertised enabled level (preferring the model default).
Configuration Test/Check explicitly turns controllable thinking off. All calls
within a plan, including a validation correction, use its frozen choice. Otherwise
it omits reasoning parameters and preserves provider defaults. Normal output budgets
remain uncapped. Capability discovery never proves that a provider will honor its
advertised settings; provider HTTP rejections are not automatically retried.

Detected local Ollama completion models use schema-constrained `response_format` on the OpenAI-compatible endpoint; no OpenRouter routing fields are sent. Cloud/remote Ollama models retain prompt-only formatting unless separately supported.

The same cached OpenRouter catalog lookup discovers native structured-output support.
When both `response_format` and `structured_outputs` are advertised for the selected
fixed model, Test/Check and normal generations send one strict JSON Schema for
`answer` and `changes`, with `provider.require_parameters: true` so incompatible
endpoints cannot silently drop it. Generic compatible APIs, dynamic routers and
unknown capabilities receive the compact prompt-only contract. A rejected schema
request fails normally without automatic fallback, retry, model substitution, or an
additional model round trip. Conversation history retains concise answers, not
repeated block replacements; current blocks and pending review are supplied afresh.

Editing acknowledgements use the shared sentence "Suggested changes are ready to
review." rather than per-section headings or claims that edits were applied. Local
no-change acknowledgements are omitted when other sections propose edits. Exact
acknowledgement duplicates are collapsed; substantive answers and limitations remain.
Proposal revisions give a brief confirmation about the suggestions, while questions
remain normal conversation replies. No extra generation request is used to combine
replies.

AI request recovery and provider profiles:

- Session metadata includes the current `job` snapshot atomically with the draft.
  Job start is idempotent for the same frozen plan ID and original version,
  including after completion. Recovery resumes that job; it never submits a new
  plan or repeats provider generation merely because a response was lost.
- After an ambiguous review response, the editor reconciles session state and
  persists an already accepted draft before permitting more mutations. If state
  cannot be read, Check status is available and further edits/generation stay
  locked. Cancellation needs acknowledgement or a confirmed terminal job state;
  a failed cancellation request alone is not reported as cancelled.
- Enter sends a prompt; Ctrl+Enter (or Cmd+Enter) inserts a newline. During work,
  the send button becomes the square stop button. Elapsed time updates each second.
- The message composer lists saved providers. Selecting a checked provider sets it as
  default; the next request uses it while preserving pending suggestions.
  `POST /api/ai/sessions/{id}/configuration` accepts `{configuration_id, version}`
  and returns the updated session. Switching is blocked during planning/generation
  and invalidates an earlier plan. Session metadata includes `configuration_id`.
- Mobile Note/AI tabs keep the live session, query and scroll positions. Selecting
  text in Note exposes Ask AI; pending changes are reviewed there at full width.
  `POST /api/ai/sessions/{id}/context` accepts `{scope, text, version}`. It keeps
  conversation history and historical suggestion labels, but requires all pending
  changes to be resolved. It archives old hunks, clears undo offsets, and invalidates
  the old plan. Retrying the same context update at its original version is safe
  until another session mutation occurs.
- Configuration `context_tokens` (0 or 2,048–16,777,216) and `concurrency` (0–8)
  tune planning only. Changing them does not invalidate the check or need a retest.
- Configuration `output_profile` is empty for automatic capability detection, or
  `json_schema` to explicitly use native strict JSON schema with another compatible
  server. Test the exact profile before saving; receipts bind it along with URL,
  model and key, and changing it invalidates the check. Unsupported schema requests
  fail without an automatic prompt-only fallback. Native schema bytes, including
  ID enums, are included in context estimates. Test/Check use a 610-second browser
  timeout around the provider's ten-minute deadline.
