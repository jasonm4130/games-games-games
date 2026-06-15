# Security Policy

This is a personal portfolio project, but security reports are welcome and appreciated.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Email **jasonm4130@gmail.com** with:

- a description of the issue and its impact,
- steps to reproduce (a proof of concept if you have one),
- the affected endpoint, component, or file.

I'll acknowledge within a few days and keep you posted on a fix.

## Scope notes

- The app is a RAG demo over tabletop rulebooks. The eval endpoints (`/api/eval/*`) are gated by a
  secret and return 404 when it's unset.
- Prompt-injection hardening lives in `src/server/rag/prompt.ts` and is exercised by
  `pnpm inject-eval`. Reports of new injection vectors that defeat the grounding/refusal rules are
  especially useful.
