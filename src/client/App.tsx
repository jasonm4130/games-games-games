import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { RulesAgent } from "../server/agent";
import type { Citation, RulesAgentState, RulesUIMessage } from "../shared/types";

function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function citationsOf(message: RulesUIMessage): Citation[] {
  for (const part of message.parts) {
    if (part.type === "data-citations") return part.data;
  }
  return [];
}

function pageLabel(citation: Citation): string {
  if (citation.pageStart == null) return "";
  if (citation.pageEnd != null && citation.pageEnd !== citation.pageStart) {
    return ` · p.${citation.pageStart}–${citation.pageEnd}`;
  }
  return ` · p.${citation.pageStart}`;
}

/**
 * A per-browser-tab session id. Without an explicit `name`, every visitor shares one "default"
 * DO instance — i.e. one shared conversation (a PII leak across users). A random id per tab,
 * held in sessionStorage, isolates each Session to its own Durable Object.
 */
function getSessionId(): string {
  const KEY = "ggg-session-id";
  let id = sessionStorage.getItem(KEY);
  if (!id) {
    id = crypto.randomUUID();
    sessionStorage.setItem(KEY, id);
  }
  return id;
}

export default function App() {
  const [input, setInput] = useState("");
  const [games, setGames] = useState<Array<{ id: string; name: string }>>([]);
  const [sessionName] = useState(getSessionId);
  const endRef = useRef<HTMLDivElement>(null);

  // Agent name is kebab-case in the URL ("rules-agent"), not the PascalCase DO class name.
  // `name` isolates this tab to its own DO instance (see getSessionId).
  const agent = useAgent<RulesAgent, RulesAgentState>({
    agent: "rules-agent",
    name: sessionName,
  });
  const { messages, sendMessage, status, clearHistory, stop } = useAgentChat<
    RulesAgentState,
    RulesUIMessage
  >({ agent });

  const activeGameId = agent.state?.activeGameId;
  const isStreaming = status === "streaming" || status === "submitted";

  // Load the Catalogue once the agent connection is ready.
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount; the agent stub is stable for the connection.
  useEffect(() => {
    let cancelled = false;
    agent.ready
      .then(() => agent.stub.listGames())
      .then((list) => {
        if (!cancelled) setGames(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the message list changes, even though the effect body only touches the ref.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming || !activeGameId) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>games-games-games</h1>
        <div className="app__controls">
          <select
            className="game-picker"
            aria-label="Select a game"
            value={activeGameId ?? ""}
            onChange={(event) => agent.stub.selectGame(event.target.value)}
          >
            <option value="" disabled>
              {games.length === 0 ? "No games onboarded" : "Select a game…"}
            </option>
            {games.map((game) => (
              <option key={game.id} value={game.id}>
                {game.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="ghost"
            onClick={() => clearHistory()}
            disabled={messages.length === 0}
          >
            New conversation
          </button>
        </div>
      </header>

      <main className="chat">
        {messages.length === 0 ? (
          <p className="chat__empty">
            {activeGameId
              ? "Ask a rules question about the selected game."
              : "Pick a game to start. Answers are grounded in that game's rulebooks, with citations."}
          </p>
        ) : (
          messages.map((message) => {
            const citations = message.role === "assistant" ? citationsOf(message) : [];
            return (
              <div key={message.id} className={`msg msg--${message.role}`}>
                <span className="msg__role">{message.role}</span>
                <div className="msg__body">{textOf(message)}</div>
                {citations.length > 0 && (
                  <div className="citations">
                    {citations.map((citation, index) => (
                      <div key={citation.chunkId} className="citation">
                        <span className="citation__n">[{index + 1}]</span>
                        <div className="citation__detail">
                          <span className="citation__meta">
                            {citation.gameName}
                            {pageLabel(citation)}
                          </span>
                          <span className="citation__text">{citation.text}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={
            activeGameId
              ? "e.g. Can I trade with the bank on another player's turn?"
              : "Pick a game first"
          }
          aria-label="Rules question"
          disabled={!activeGameId}
        />
        {isStreaming ? (
          <button type="button" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim() || !activeGameId}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
