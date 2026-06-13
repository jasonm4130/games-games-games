---
status: accepted
---

# Retrieval is scoped to one active Game via Vectorize metadata

A Session is about **one active Game** at a time (see CONTEXT.md). Retrieval is always
filtered to that Game: every vector is upserted with `game_id` metadata at ingest, and
`retrieve()` passes `filter: { game_id }` to the Vectorize query. The `RulesAgent` holds the
active Game (`activeGameId`); the user picks one from the Catalogue before chatting.

**Why this is an ADR:** Vectorize metadata is written **at upsert time**. If retrieval needs
to filter by Game, every vector must carry `game_id` from the very first ingest — adding it
later means re-upserting every vector in the index. So the decision is hard to reverse once
any rulebook is indexed, and it has to be settled before Ingestion is implemented.

**Why scope per-Game (not global search):**

- A rules question like *"how many cards do I draw to start?"* is meaningless across games.
  Global search over every rulebook returns top-k chunks from several games at once, and the
  model blends them into a confident, wrongly-cited answer. Per-Game scoping is the single
  biggest lever on answer correctness.
- The Catalogue is operator-curated and the user selects a Game, so a scoping key always
  exists — there is no "search everything" use case to preserve.

**Consequences:**

- Chunk `id` doubles as the Vectorize vector id; a query match hydrates its text + page span
  by joining `match.id = chunks.id` in D1 (no separate `vector_id` column to drift).
- `retrieve(env, question, { gameId })` returns `[]` when no Game is active — nothing to
  search. Matches below `RETRIEVAL_MIN_SCORE` are dropped so weak passages don't ground a
  Ruling.
- `activeGameId` on the agent must persist across Durable Object hibernation (feature-phase
  TODO) and be set by a client Game picker.
