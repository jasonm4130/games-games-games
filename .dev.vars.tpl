ELEVENLABS_API_KEY=op://Private/games-goblin-elevenlabs/credential
# Operator secret gating the eval harness endpoints (POST /api/eval/*, GAP 2 / ADR 0007). When
# unset the endpoints 404 (invisible). In prod set it with `wrangler secret put EVAL_SECRET`; the
# operator scripts read the same value from the EVAL_SECRET env var. Any high-entropy string.
EVAL_SECRET=op://Private/games-eval-secret/credential
