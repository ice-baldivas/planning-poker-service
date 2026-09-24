# Planning Poker — Backend Service

Express 5 + Socket.IO 4 backend for the planning poker app. The Angular frontend lives in the sibling workspace folder `planning-poker` (its spec: `../planning-poker/spec/spec-design-planning-poker-web-app.md`).

## Commands

- `npm run dev` — nodemon + ts-node, watches `src/**/*.ts`
- `npm run build` — `tsc` to `dist/`
- `npm start` — `node dist/index.js`
- `npm test` — builds TypeScript, then runs Node's built-in tests in `tests/*.test.cjs` (session store and socket handlers).

TypeScript strict mode, **CommonJS** modules (keep imports/exports CJS-compatible).

## Architecture

All state is **in-memory** in the singleton `sessionStore` ([src/session-store.ts](src/session-store.ts)) — no DB, everything is lost on restart, and the design assumes a single process (no horizontal scaling without a socket.io adapter + shared store).

- [src/index.ts](src/index.ts) — Express + manual CORS middleware, mounts `/api/sessions`, attaches socket.io, runs a 60s cleanup sweep (`setInterval(...).unref()`).
- [src/routes/sessions.ts](src/routes/sessions.ts) — REST: `POST /api/sessions` (create → `{ session_id }`), `GET /api/sessions/:id` (public metadata).
- [src/socket/handlers.ts](src/socket/handlers.ts) — all socket event handlers; the real API surface.
- [src/types.ts](src/types.ts) — domain types + `VOTING_SCALES`. **`SessionState` (client-facing) must never contain vote values**; internal types (`InternalSession`, `InternalParticipant`) hold `votes` and `socket_id`. Use `toClientState()` when emitting state. Keep types in sync with the frontend's `src/app/shared/types.ts`.
- [src/rate-limiter.ts](src/rate-limiter.ts) — in-memory limiter: 10 failed `join_session` lookups / 60s / IP (session codes are 6-digit numeric, so brute-force protection matters).
- [src/utils.ts](src/utils.ts) — `sanitize()`/`sanitizeText()` for **all** user-supplied strings (HTML strip + length caps); always run new user input through these.

## Conventions

- Socket errors are emitted as `error` with `{ code, message }` — codes: `INVALID_INPUT`, `SESSION_NOT_FOUND`, `NOT_IN_SESSION`, `FORBIDDEN`, `INVALID_CARD`, `INVALID_STATE`, `NOT_FOUND`, `RATE_LIMITED`. Reuse these; don't invent new codes without need.
- Moderator-only events (`reveal_votes`, `reset_round`, `add_story`, `set_active_story`, `finalize_story`, `transfer_sm`, `remove_participant`) must check the caller's role.
- `sm_` event names (`transfer_sm`, `sm_transferred`, `new_sm_id`) are legacy "Scrum Master" naming for the moderator role — keep names stable; the frontend depends on them.
- `session_state` (with `your_participant_id`) goes only to the requesting socket; everything else broadcasts to the room.

## Timing behavior (session-store)

- Session inactivity TTL: 4h; empty session: 30min; disconnected participant pruned after 15min; sweep every 60s.
- Moderator disconnect triggers a 60s timer that auto-transfers the role to the first connected non-observer.

## Environment

Only two env vars: `PORT` (default 3000) and `CORS_ORIGIN` (default `http://localhost:4200`, single origin only).
