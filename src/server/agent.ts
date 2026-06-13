import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  streamText,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import type { Citation, RulesAgentState, RulesUIMessage } from "../shared/types";
import { GENERATION_MODEL } from "./rag/models";
import { retrieve } from "./rag/retrieve";

const SYSTEM_PROMPT = `You are a precise tabletop-game rules assistant. Answer the player's \
question about a game's rules. Ground every answer in the retrieved rulebook passages and \
cite them inline as [1], [2], etc., using only the numbers of the passages provided, in \
order. If the passages do not cover the question, say so plainly instead of guessing.`;

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
  }

  /** Callable from the client via `agent.stub.listGames()`. */
  @callable()
  async listGames(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.env.DB.prepare("SELECT id, name FROM games ORDER BY name")
      .all<{ id: string; name: string }>()
      .catch(() => null);
    return result?.results ?? [];
  }

  async onChatMessage(
    // The framework invokes this with a no-op callback; persistence happens automatically
    // via toUIMessageStreamResponse(), so it is intentionally unused. Type is pulled from
    // the base signature to avoid guessing the AI SDK export name.
    _onFinish: Parameters<AIChatAgent<Env>["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const messages = await convertToModelMessages(this.messages);

    const passages = await retrieve(this.env, lastUserText(this.messages), {
      gameId: this.state.activeGameId,
    });
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
