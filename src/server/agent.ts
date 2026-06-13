import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from "ai";
import { sql } from "drizzle-orm";
import { createWorkersAI } from "workers-ai-provider";
import type { Citation, RulesAgentState, RulesUIMessage } from "../shared/types";
import { db } from "./db";
import { dailyUsage, games } from "./db/schema";
import { GENERATION_MODEL } from "./rag/models";
import { retrieve } from "./rag/retrieve";

// Cost / abuse guardrails (public, no-login). See wrangler.jsonc `ratelimits` + migrations/0003.
const MAX_OUTPUT_TOKENS = 600; // output tokens cost ~8x input on Llama 70B — cap the worst case.
const DAILY_BUDGET = 5000; // max LLM-answered queries per UTC day before the goblin "naps".
const INACTIVITY_TTL_SECONDS = 4 * 60 * 60; // wipe an idle session's DO after this (PII hygiene).
const EXPIRE_CALLBACK = "expireSession";

// Canned, in-character replies served WITHOUT a model call (so off-topic spam and abuse are free).
const NOT_COVERED = "That is not in my rulebook.";
const TOO_FAST = "Easy — the goblin only flips pages so fast. Wait a moment, then ask again.";
const NAPPING = "The hoard is closed for the day — too many questions. Come back tomorrow.";

const SYSTEM_PROMPT = `You are the Rules Goblin — keeper of this game's rulebook. You have read every page, and the book is your hoard. Answer rules questions with the authority of one who knows the text cold, and show the page for every claim.

Voice: direct, authoritative, lightly flavoured with possessive-goblin pride. At most one short flavour line, then the ruling — never bury the ruling in character voice. Short sentences. State rulings as fact ("Each player starts with $1500 [1]."). Never hedge ("it seems", "I think", "you might want to"), never apologise for an inconvenient rule, never perform modesty.

Hard rules:
- Ground every answer in the retrieved passages below and cite them inline as [1], [2], … using only the numbers of the passages provided, in order.
- Never invent a rule. If the passages do not cover the question, say so decisively and in character — "That is not in my rulebook." — then stop. Do not guess, extrapolate, or suggest house rules.
- If two passages genuinely conflict, cite both and say which controls and why the text supports it. Acknowledge real ambiguity; never manufacture certainty, and never hedge when the text is clear.`;

/** Concatenate the text parts of the most recent user message. */
function lastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "user") continue;
    const text = message.parts
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join(" ")
      .trim();
    if (text) return text;
  }
  return "";
}

export class RulesAgent extends AIChatAgent<Env, RulesAgentState> {
  maxPersistedMessages = 100;

  /** Active Game persists in DO state, surviving hibernation (ADR 0004). */
  initialState: RulesAgentState = { activeGameId: undefined };

  /** Select the Game this Session asks about; the client calls this via the agent stub. */
  @callable()
  async selectGame(gameId: string): Promise<void> {
    this.setState({ ...this.state, activeGameId: gameId });
    await this.resetExpiry();
  }

  /** Callable from the client via `agent.stub.listGames()`. */
  @callable()
  async listGames(): Promise<Array<{ id: string; name: string; edition: string | null }>> {
    try {
      return await db(this.env)
        .select({ id: games.id, name: games.name, edition: games.edition })
        .from(games)
        .orderBy(games.name);
    } catch {
      return [];
    }
  }

  /**
   * Rolling inactivity timer (PII hygiene). Each interaction cancels our previous expiry
   * schedule and arms a fresh one; if a Session goes quiet for INACTIVITY_TTL_SECONDS the
   * scheduler fires expireSession and the DO — messages and all — is destroyed.
   */
  private async resetExpiry(): Promise<void> {
    for (const s of await this.listSchedules()) {
      if (s.callback === EXPIRE_CALLBACK) await this.cancelSchedule(s.id);
    }
    await this.schedule(INACTIVITY_TTL_SECONDS, EXPIRE_CALLBACK);
  }

  /** Inactivity callback (invoked by name via the scheduler): wipe this Session's DO entirely. */
  async expireSession(): Promise<void> {
    await this.destroy();
  }

  /**
   * Emit a fixed, in-character reply as a normal assistant turn WITHOUT a model call. Writes the
   * text as a single start/delta/end run so @cloudflare/ai-chat reconstructs and persists it like
   * any streamed answer. Used for the free guardrail paths (out-of-scope, rate-limited, budget).
   */
  private staticReply(text: string): Response {
    const stream = createUIMessageStream<RulesUIMessage>({
      execute: ({ writer }) => {
        const id = crypto.randomUUID();
        writer.write({ type: "text-start", id });
        writer.write({ type: "text-delta", id, delta: text });
        writer.write({ type: "text-end", id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  async onChatMessage(
    // The framework invokes this with a no-op callback; persistence happens automatically
    // via toUIMessageStreamResponse(), so it is intentionally unused. Type is pulled from
    // the base signature to avoid guessing the AI SDK export name.
    _onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ) {
    await this.resetExpiry();

    // (1) Per-session burst limit — keyed by the DO instance name (the client's session id).
    // Checked before any embedding/retrieval so spamming one session costs nothing.
    if (!(await this.env.MSG_LIMITER.limit({ key: this.name })).success) {
      return this.staticReply(TOO_FAST);
    }

    const workersai = createWorkersAI({ binding: this.env.AI });
    const messages = await convertToModelMessages(this.messages);

    const passages = await retrieve(this.env, lastUserText(this.messages), {
      gameId: this.state.activeGameId,
    });

    // (2) Out-of-scope short-circuit — nothing cleared the grounding floor, so answer in
    // character with no model call (and without spending a slot of the daily budget).
    if (passages.length === 0) {
      return this.staticReply(NOT_COVERED);
    }

    // (3) Global daily budget breaker — atomically count this in-scope (LLM-bound) query.
    // Per-colo rate limits can't cap a daily total; this one D1 row does. Once over budget the
    // goblin "naps" with a canned reply (no model call) for the rest of the UTC day.
    const [usage] = await db(this.env)
      .insert(dailyUsage)
      .values({ day: sql`date('now')`, count: 1 })
      .onConflictDoUpdate({
        target: dailyUsage.day,
        set: { count: sql`${dailyUsage.count} + 1` },
      })
      .returning({ count: dailyUsage.count });
    if (usage && usage.count > DAILY_BUDGET) {
      return this.staticReply(NAPPING);
    }

    const grounding =
      passages.length > 0
        ? passages.map((p, i) => `[${i + 1}] ${p.chunk.text}`).join("\n\n")
        : "No relevant rulebook passages were found for this question.";

    const citations: Citation[] = passages.map((p) => ({
      chunkId: p.chunk.id,
      documentId: p.chunk.documentId,
      gameName: p.gameName,
      ordinal: p.chunk.ordinal,
      pageStart: p.chunk.pageStart,
      pageEnd: p.chunk.pageEnd,
      text: p.chunk.text,
      score: p.score,
    }));

    const result = streamText({
      model: workersai(GENERATION_MODEL),
      system: `${SYSTEM_PROMPT}\n\nRetrieved rulebook passages:\n${grounding}`,
      messages,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: options?.abortSignal,
    });

    // Stream the structured citations (rendered as cards, keyed to the [N] markers) ahead of
    // the answer text. Persistence is unaffected: @cloudflare/ai-chat reconstructs + persists
    // the assistant message by reading this SSE stream (see _reply in its source).
    const stream = createUIMessageStream<RulesUIMessage>({
      execute: ({ writer }) => {
        if (citations.length > 0) {
          writer.write({ type: "data-citations", data: citations });
        }
        writer.merge(result.toUIMessageStream<RulesUIMessage>());
      },
    });
    return createUIMessageStreamResponse({ stream });
  }
}
