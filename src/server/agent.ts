import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { callable } from "agents";
import { convertToModelMessages, streamText, type UIMessage } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { GENERATION_MODEL } from "./rag/models";
import { retrieve } from "./rag/retrieve";

const SYSTEM_PROMPT = `You are a precise tabletop-game rules assistant. Answer the player's \
question about a game's rules. Ground every answer in the retrieved rulebook passages and \
cite them inline as [1], [2], etc. If the passages do not cover the question, say so plainly \
instead of guessing.`;

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

export class RulesAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;

  /** Callable from the client via `agent.stub.listGames()`. */
  @callable()
  async listGames(): Promise<Array<{ id: string; name: string }>> {
    const result = await this.env.DB.prepare("SELECT id, name FROM games ORDER BY name")
      .all<{ id: string; name: string }>()
      .catch(() => null);
    return result?.results ?? [];
  }

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({ binding: this.env.AI });
    const messages = await convertToModelMessages(this.messages);

    const passages = await retrieve(this.env, lastUserText(this.messages));
    const grounding =
      passages.length > 0
        ? passages.map((p, i) => `[${i + 1}] ${p.chunk.text}`).join("\n\n")
        : "No rulebook passages are available yet (ingestion is not implemented). " +
          "Tell the user their answer is unverified.";

    const result = streamText({
      model: workersai(GENERATION_MODEL),
      system: `${SYSTEM_PROMPT}\n\nRetrieved rulebook passages:\n${grounding}`,
      messages,
      abortSignal: options?.abortSignal,
    });

    return result.toUIMessageStreamResponse();
  }
}
