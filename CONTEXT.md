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
expansions, errata). Stored as an uploaded file in R2.
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
The pipeline that turns an uploaded Rulebook into indexed Chunks: parse → chunk → embed →
upsert into Vectorize (with metadata in D1).
_Avoid_: import, upload, processing

**Retrieval**:
Finding the Chunks most relevant to a question by querying Vectorize with the question's
embedding.
_Avoid_: search, lookup, query

**Session**:
A user's ongoing conversation with the agent about one or more Games — backed by one
`RulesAgent` Durable Object instance.
_Avoid_: conversation, thread, chat
