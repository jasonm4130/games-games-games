# games-games-games

A Cloudflare-native app that answers tabletop game rules questions, grounded in the
official rulebooks and cited back to their source passages.

## Language

**Game**:
A specific tabletop/board/card game whose rules the system can answer about. Identity is
the title plus edition (the 2nd edition of a game is a different Game).
_Avoid_: title, product

**Rulebook**:
A source document describing a Game's rules. One Game may have several (base rules,
expansions, errata). Stored in R2 as the source file an operator onboards.
_Avoid_: manual, instructions, PDF (the PDF is just one encoding of a Rulebook)

**Chunk**:
A retrievable segment of a Rulebook after splitting — the unit that is embedded and stored
in Vectorize, and whose text is kept in D1 for citing.
_Avoid_: fragment, passage, segment, section

**Ruling**:
An answer the system produces to a rules question, grounded in Rulebook Chunks. A Ruling is
not authoritative game-designer errata; it is the system's grounded answer.
_Avoid_: response, result, answer

**Citation**:
A reference from a Ruling back to the specific Chunk(s) that support it, so a user can
verify the Ruling against the Rulebook.
_Avoid_: source, reference, link

**Ingestion**:
The pipeline that turns an onboarded Rulebook into indexed Chunks: parse → chunk → embed →
upsert into Vectorize (with metadata in D1). Triggered by Onboarding.
_Avoid_: import, upload, processing

**Retrieval**:
Finding the Chunks most relevant to a question, scoped to the active Game. Hybrid: a dense leg
(Vectorize, the question's embedding) and a lexical leg (BM25 over the Rulebook text) are fused,
then a reranker decides what is in scope. Both legs are Game-scoped.
_Avoid_: search, lookup, query

**Session**:
A user's ongoing conversation with the agent about **one active Game**, chosen from the
Catalogue at the start and switchable during the conversation. Backed by one `RulesAgent`
Durable Object instance, which holds the active Game. Retrieval is always scoped to the
active Game.
_Avoid_: conversation, thread, chat

**Catalogue**:
The set of Games that have been onboarded and are therefore selectable by a user. The
Catalogue is curated by an operator, not built by end users — there is no end-user
sign-up or self-serve upload.
_Avoid_: library, collection, list

**Onboarding**:
The operator action of adding a Game and its Rulebook(s) to the Catalogue. The only way a
Game enters the system; it triggers Ingestion. Distinct from a user starting a Session.
_Avoid_: upload, import, signup

**Gold set**:
A curated list of rules questions paired with the Chunk(s) that should answer each — the
ground truth the Eval scores Retrieval against. Catalogue-wide and verified against live D1
(`eval/gold/catalogue.json`): every row's `expectedChunkIds` must exist for the right Game.
_Avoid_: test set, fixtures, benchmark

**Eval**:
The operator measurement of Retrieval quality against a Gold set (Hit-Rate@5, Recall@20,
Precision@5; dense-vs-hybrid deltas) and of answer quality across generation models. Not a
user-facing feature — an operator harness.
_Avoid_: test, benchmark, score
