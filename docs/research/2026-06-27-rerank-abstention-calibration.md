<!-- Deep-dive synthesis (5 parallel research agents + blind per-angle verification, 2026-06-27)
PLUS a measured calibration probe of the live reranker over the full gold corpus (102 questions,
9 games, prod). Follows up the 2026-06-14 architecture review's "reranker is the real gate"
conclusion and nuances it: the reranker is the right RANKER, but its absolute score cannot GATE
scope. Academic claims carry per-claim reliability flags from the verification pass; re-verify
fast-moving model/catalog facts before acting. -->

# Reranker scores as an abstention gate — research + measurement (June 2026)

## 1. Bottom line

- **A reranker/cosine score is a good *ranker* but cannot *gate scope*.** This is the unanimous finding across the 2023–2026 literature **and** is now measured on our own corpus: across 102 gold questions in 9 games, genuine answer chunks and irrelevant out-of-scope chunks produce **fully overlapping** reranker-score distributions. No threshold separates them.
- **Our current design was the right instinct.** `RERANK_MIN_SCORE=0.05` as a *noise floor* + delegating the answer/refuse call to the LLM is closer to best practice than a hard reranker cutoff. We did not make the common mistake.
- **But the floor is not separating scope, and no score-based gate can.** At 0.05 the gate drops the gold chunk on **19%** of answerable questions while still passing a candidate on **~43%** of (hard) out-of-scope queries. There is no cutoff — and, by extension, no relative-margin or dual-score reshape — that gets both error rates acceptable, because the two distributions overlap end to end.
- **Consequence for the open work:** the premise of PR #12 (rescue the consensus top *from the score gate*) and any "tune the threshold / fuse two scores" plan is **refuted by the data** for the scope-decision job.
- **And the answerability check we expected to need turned out redundant (§8–§9).** A focused 70B "do these passages answer X?" gate (89.2% balanced) refuses OOS *identically* to the current inline judge (83.3% both); the only difference is the inline pipeline false-refuses more answerable questions — caused by the **floor**, not the judgment. So **the lever is the floor, not a second call:** lower/remove `RERANK_MIN_SCORE` to stop denying the inline judge its gold chunks. Cheap models can't do the judgment at all (llama-3.2-1b refuses nothing; 3b/granite over-refuse).
- **SHIPPED & CONFIRMED LIVE (§9.1).** Lowered `RERANK_MIN_SCORE` 0.05 → 0.01 (PR #14, deployed). Post-deploy prod `--baseline`: answerable→answer **84.3% → 93.1%**, OOS refusal **unchanged at 83.3%**, balanced **83.8% → 88.2%** — the separate-gate's level captured with one constant and zero new calls.
- **The deepest reason (ELOQ):** out-of-scope questions are *semantically close to the documents that cannot answer them*. "Good retrieval score" and "answerable query" are different axes; a retrieval score can't tell them apart by construction.

## 2. The question

Is semantic-similarity / reranker-score thresholding a valid signal for deciding *answer vs refuse* in our single-rulebook RAG (bge-m3 dense + BM25, RRF, bge-reranker-base, gate at `RERANK_MIN_SCORE=0.05`, abstention delegated to llama-3.3-70b)? Or is there something better?

## 3. What best-in-class RAG does (synthesis)

Abstention happens at three stages; the reliable signal is never a raw score.

**(A) Retrieval-time gating** — decide if the context is good enough before generating:
- **CRAG** — a lightweight T5-Large retrieval evaluator labels retrieval Correct / Ambiguous / Incorrect; **84.3%** relevance-classification accuracy vs ChatGPT's 58–65%. A dedicated small evaluator beats asking the generator. ([Yan et al. 2024](https://arxiv.org/abs/2401.15884))
- **NLI entailment filtering** — does the context *entail an answer*, rather than merely score similar. ([Yoran et al. 2024, via CRAG](https://arxiv.org/html/2401.15884v3))
- **Goodness-of-fit / OOD tests** — compare the query against the in-scope query distribution statistically. ([Li et al., EMNLP 2024](https://aclanthology.org/2024.emnlp-main.353); reliability: *partial* — abstract-only access)
- **Conformal thresholds** — CONFLARE / Principled Context Engineering calibrate the cutoff for a coverage guarantee. Fixed cosine θ=0.50 gave **76%±20%** coverage across queries (uncontrolled); conformal tracks the target. ([CONFLARE](https://arxiv.org/html/2404.04287v1); [Principled Context Engineering](https://arxiv.org/html/2511.17908v2))
- **Calibrated reranker abstention** — a linear `u_lin` over the score distribution, **1.2%** overhead. ([Gisserot-Boukhlef et al., EMNLP 2024](https://arxiv.org/abs/2402.12997))

**(B) Generation-time abstention** — Self-RAG reflection tokens (trained-in, not prompted), Contrastive Decoding with Abstention, semantic entropy, refusal fine-tuning (RAFT/R-Tuning), and **prompt instructions — where we are.**

**(C) Post-generation verification** — claim-level NLI entailment (Provenance, Lynx), RAGAS faithfulness, LLM-judge. A production case study cut unsupported answers to ~6% with a claim-NLI pass at ~110–120ms / $0.0003 per check (single-source blog; treat as illustrative).

**Is "delegate to the LLM" enough?** It's a fine default with a measured ceiling:
- **FaithEval (ICLR 2025):** best model only **71.8%** on unanswerable contexts even with chain-of-thought. ([paper](https://arxiv.org/html/2410.03727v1))
- **AbstentionBench (Meta FAIR, 20 LLMs, 35k queries):** "abstention is an unsolved problem… scaling models is of little use"; reasoning fine-tuning *degrades* it ~24%. ([paper](https://arxiv.org/html/2506.09038v1))
- **A dedicated verifier beats self-judgment** (CRAG 84.3% vs 58–65%; Lynx > GPT-4o on HaluBench).

> Verification flags folded in: CRAG's "~20% over Self-RAG" is the cherry-picked backbone comparison (natural comparison ≈ 6.9pp); two CRAG deltas in the raw research were wrong and dropped; one "LlamaIndex says don't threshold, let the LLM judge" source was **unverifiable** (and LlamaIndex ships a `SimilarityPostprocessor(cutoff=0.7)`), so "the framework endorses our approach" is folk wisdom, not established practice.

## 4. Is reranker/semantic scoring a valid scope signal? (literature: verified *high*)

No, not as an absolute judge:
- Cross-encoder scores are **unbounded logits trained to rank, not calibrated probabilities** — the bge-reranker-base model card itself says scores are "not bounded to a specific range" and "what matters is the relative order, not the absolute value." (Workers AI sigmoids to [0,1], but a sigmoid of an uncalibrated logit is still uncalibrated.)
- Score scale is **query- and domain-dependent** — RSRank measured a 0.379 bias between the model's 0.5 boundary and the dataset-optimal threshold; the *same* reranker scored a relevant English passage 0.995 and a relevant Chinese one 0.21.
- **Ranking-correctness and calibration are independent.** Uncalibrated scores still *sort* correctly; they only break when a *decision* (refuse/fallback) rides the absolute value — exactly the line we walk.
- The better-than-fixed-cutoff signals are **relative** (top-vs-spread margin, dual-score fusion) — but see §5: on our corpus even those can't separate, because the overlap is in the scores themselves.

## 5. Measured on our corpus (2026-06-27, prod, 102 gold Qs / 9 games)

Re-ran the *exact* production reranker over the real fused candidate windows and recorded the scores the live gate discards. In-scope = gold question vs its own game; OOS = same question vs the **wrong** game (worst-case "game-shaped but unanswerable") + 4 out-of-domain nonsense queries.

Reranker score (sigmoid-normalised [0,1]):

| distribution | n | min | p10 | p50 | p90 | max |
|---|---|---|---|---|---|---|
| in-scope TARGET chunk | 100 | 0.0007 | 0.0100 | 0.806 | 0.999 | 0.9998 |
| in-scope TOP candidate | 102 | 0.0107 | 0.0594 | 0.956 | 0.9995 | 1.0000 |
| OOS TOP candidate | 106 | 0.0000 | 0.0004 | 0.018 | 0.753 | 0.9969 |

Threshold sweep — false-refusal (gold target gated out) vs false-accept (OOS junk clears):

| cutoff | false-refusal | false-accept |
|---|---|---|
| 0.01 | 10.0% | 56.6% |
| 0.025 | 16.0% | 47.2% |
| **0.05 (current)** | **19.0%** | **42.5%** |
| 0.1 | 23.0% | 34.0% |
| 0.15 | 27.0% | 28.3% |
| 0.2 | 29.0% | 27.4% |
| 0.3 | 31.0% | 24.5% |
| 0.5 | 38.0% | 17.0% |

**VERDICT: OVERLAPPING.** No cutoff keeps both error rates ≤10%. Genuine answer chunks span the *entire* range (some real targets score 0.0007); OOS chunks reach 0.997. The median separates (in-scope target 0.81 vs OOS 0.018), but the **tails overlap completely**, and the gate lives in the tails. This is the Monopoly anecdote (`models.ts`) reproduced at corpus scale.

**Caveats on the measurement:**
- **Cross-game is a *worst-case* OOS proxy.** A wrong rulebook is structurally game-shaped, so its chunks rerank high — production never serves cross-game queries (the `game_id` filter blocks them), so the real in-production false-accept rate is *lower* than 42.5%. But the high cross-game scores still prove the reranker hands high scores to game-shaped-but-wrong content, which is exactly the in-game meta/unanswerable case. Only 4 of 106 OOS points are the cleaner out-of-domain nonsense; a larger genuine in-game-unanswerable set would sharpen this.
- **"False-refusal" = the gold chunk scored below the cutoff**, so grounding loses the right chunk (the query may still answer from a sibling or refuse) — it's a grounding-precision loss, not necessarily a full refusal.
- Single run; the reranker is deterministic so re-runs are stable, but the gold set is small per game.

## 6. Decision & recommendations

1. **Keep `RERANK_MIN_SCORE` as a pure noise floor; the LLM remains the scope judge (by design).** Do not promote the reranker score to a scope *judge*. (Optionally test lowering toward ~0.01–0.025 to recover the ~9% of gold chunks gated out between 0.01 and 0.05 — but that pushes *more* junk to the LLM, whose own scope-judgment has a ~70% ceiling, so gate that on a generation-side measurement, not this one.)
2. **The PR #12 premise is refuted for the scope job.** No score-based gate — fixed floor, relative margin, or cosine×reranker fusion — separates in-scope from OOS here. Close PR #12, or keep it *only* as a narrow recall fix for the specific Quacks-components case with eyes open that it raises OOS leakage. Do not invest in dual-score gating for abstention.
3. **The real lever is an answerability check** (ELOQ): ask "do these passages answer X?" not "is this passage relevant?" — a different question than relevance, that beats the score. Workers AI has **no NLI/entailment model** (only `distilbert-sst-2` sentiment + the reranker), so the check is a focused LLM call. Measured — see §8: **only the 70B does it well (89.2% balanced); the cheap models fail** (AbstentionBench confirmed). So it is *not* a cheap-model win — it's a focused second call on the model we already run, justified only if it beats the inline generator judgment (next measurement).
4. **Skip** (ruled out by our constraints): conformal as a silver bullet (no production deployments, can't separate overlapping distributions, heavyweight variants like TRAQ ≈ 15× generation cost); Self-RAG/RAFT (require fine-tuning a custom model — we're on hosted models); semantic entropy (N× generation cost).

## 7. Reproduce

`tools/operator-scripts/rerank-calibrate.ts` (`pnpm rerank-calibrate`). Zero production-code change — it re-runs the live reranker over `/api/eval/retrieve`'s real candidate windows. Re-run after any retrieval/chunking/embedding change, or with a genuine in-game-unanswerable gold set to replace the cross-game proxy:

```
EVAL_SECRET=… pnpm rerank-calibrate [--gold eval/gold/common.json] [--games Monopoly,Catan] [--limit N]
```

## 8. Answerability trial (2026-06-27, prod, 102 answerable + 12 unanswerable / 9 games)

Tested whether a focused "do these passages answer X?" LLM call separates scope where the score can't. Each model judged ANSWERABLE / PARTIAL / UNANSWERABLE over the top-5 reranked passages (no floor — answerability is meant to *replace* the floor). Answerable group = `common.json` + `catalogue.json`; unanswerable group = `eval/gold/unanswerable.json` (in-game strategy/history/price/opinion + assistant-meta — the real production OOS). `pnpm answerability-eval`.

| model | answerable→answer | unanswerable→refuse | balanced acc |
|---|---|---|---|
| **@cf/meta/llama-3.3-70b-instruct-fp8-fast** | **95.1%** | **83.3%** | **89.2%** |
| @cf/ibm-granite/granite-4.0-h-micro | 72.5% | 83.3% | 77.9% |
| @cf/meta/llama-3.2-3b-instruct | 56.9% | 91.7% | 74.3% |
| @cf/meta/llama-3.2-1b-instruct | 97.1% | 0.0% | 48.5% |

**Read:** the 70B (already our generator) is the only viable judge — 89.2% balanced, vs the reranker score which had *no* cutoff above ~57% on either axis (§5). The cheap models each fail one direction: llama-3.2-1b says "answerable" to everything (0% refusal — useless gate), llama-3.2-3b over-refuses answerable (kills 44/102), granite hedges (24 "partial", refuses 28 answerable). This confirms AbstentionBench live — small models can't do abstention judgment. **So the answerability check is not a cheap-model win; it's a focused second 70B call** (~$0.0008, +~1–2s latency).

**Caveats:** the judge saw the *same* passages it would generate from, so a separate 70B answerability gate vs the 70B *inline* judgment (the current `prompt.ts` "WHEN THE PASSAGES FALL SHORT") is the comparison that actually decides whether to wire it in — not yet measured. The unanswerable set is only 12 (hand-curated); the 70B wrongly answered 2 of them. `gemma-4-26b-a4b-it` excluded (dead id per `models.ts`).

**Recommendation:** measured in §9 — the floor, not a second call.

## 9. Head-to-head: separate gate vs the current inline pipeline (decisive)

Ran the CURRENT production pipeline (rerank floor + inline-judge prompt + 70B generate, via `/api/eval/answer`) over the same 114 probes, classifying answered-vs-refused by citation presence (a grounded ruling carries `[n]` markers; a refusal/canned-empty does not). `pnpm answerability-eval --baseline`.

| system | answerable→answer | unanswerable→refuse | balanced |
|---|---|---|---|
| current: rerank floor + inline judge | 84.3% | 83.3% | 83.8% |
| proposed: separate 70B answerability gate (§8) | 95.1% | 83.3% | 89.2% |

**The two systems refuse OOS identically — 83.3%, the same 10/12.** The entire 5.4pp gap is on the *answerable* side (84.3% vs 95.1%), and that deficit is the **rerank floor**: §5 measured the 0.05 floor drops the gold chunk on ~19% of answerable questions, so they get refused before any judge sees them.

**Conclusion — a separate 70B answerability call is NOT worth building.** It is redundant with the inline judge (identical refuse rate), so it buys zero scope-discrimination for a second call (~$0.0008, +1–2s). The CRAG "focused call beats embedded judgment" effect did not appear — llama-3.3-70b's *inline* judgment already matches a dedicated call. The real lever is the floor: feeding the inline judge the gold chunks it is currently denied should lift 83.8% toward 89.2% with zero new calls.

**Recommendation:**
- **Lower `RERANK_MIN_SCORE` 0.05 → ~0.01** (surgical): §5's sweep cuts false-refusal 19%→10%, recovering ~half the lost answerable while keeping a garbage floor AND the free canned-refusal path for the clearest junk. Re-run `--baseline` to confirm the lift.
- **Or remove the floor entirely** (aggressive): feed top-5 always → ~89% balanced, but every OOS query then costs a generation (loses the free-refusal path the 2026-06-14 review flagged as an abuse cost-lever). Weigh cost/abuse.
- **Do NOT** add a separate answerability call — measured redundant.

Caveat: the unanswerable set is 12 hand-curated questions; both systems missing the same 2 suggests those 2 may be borderline (retrieval surfaces a tangentially-relevant chunk). A larger unanswerable gold would tighten the 83.3% refuse figure both share.

### 9.1 Shipped & confirmed live (2026-06-27, post-deploy)

Took the surgical option — `RERANK_MIN_SCORE` **0.05 → 0.01** (`models.ts`, PR #14, merged → CF Builds deployed). Re-ran `--baseline` against prod with the live floor:

| system | answerable→answer | unanswerable→refuse | balanced |
|---|---|---|---|
| before (floor 0.05) | 84.3% | 83.3% | 83.8% |
| **after (floor 0.01, live)** | **93.1%** | **83.3%** | **88.2%** |

The prediction held exactly: answerable answer-rate rose **+8.8pp** (the meta-question false-refusals recovered), OOS refusal was **unchanged** (83.3% — lowering the floor cost zero scope precision, as predicted since the LLM, not the floor, judges scope), and balanced accuracy **83.8% → 88.2%** now ≈ the separate-gate's 89.2% — captured with **one constant and no second call**. The remaining ~1pp to the no-floor ceiling is the abuse/cost trade-off in §9's aggressive option; not worth taking unless OOS-generation cost ever bites.

## Sources

bge-reranker-base [model card](https://huggingface.co/BAAI/bge-reranker-base) · ELOQ [2410.14567](https://arxiv.org/html/2410.14567v4) · RSRank [2606.17468](https://arxiv.org/html/2606.17468v1) · ZeroEntropy [calibration](https://zeroentropy.dev/concepts/score-calibration/) · CRAG [2401.15884](https://arxiv.org/abs/2401.15884) · Self-RAG [2310.11511](https://arxiv.org/abs/2310.11511) · FaithEval [2410.03727](https://arxiv.org/html/2410.03727v1) · AbstentionBench [2506.09038](https://arxiv.org/html/2506.09038v1) · Lynx [2407.08488](https://arxiv.org/html/2407.08488) · CONFLARE [2404.04287](https://arxiv.org/html/2404.04287v1) · Principled Context Engineering [2511.17908](https://arxiv.org/html/2511.17908v2) · u_lin [2402.12997](https://arxiv.org/abs/2402.12997) · ScoreGate [2606.14269](https://arxiv.org/html/2606.14269)
