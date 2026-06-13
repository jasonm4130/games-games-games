import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import type { UIMessage } from "ai";
import { type FormEvent, useEffect, useRef, useState } from "react";

function textOf(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

export default function App() {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // Agent name is kebab-case in the URL ("rules-agent"), not the PascalCase DO class name.
  const agent = useAgent({ agent: "rules-agent" });
  const { messages, sendMessage, status, clearHistory, stop } = useAgentChat({ agent });

  const isStreaming = status === "streaming" || status === "submitted";

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll to the bottom whenever the message list changes, even though the effect body only touches the ref.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }

  return (
    <div className="app">
      <header className="app__header">
        <h1>games-games-games</h1>
        <button
          type="button"
          className="ghost"
          onClick={() => clearHistory()}
          disabled={messages.length === 0}
        >
          Clear
        </button>
      </header>

      <main className="chat">
        {messages.length === 0 ? (
          <p className="chat__empty">
            Ask a rules question. No rulebooks are indexed yet, so answers are unverified until the
            ingestion pipeline lands.
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`msg msg--${message.role}`}>
              <span className="msg__role">{message.role}</span>
              <div className="msg__body">{textOf(message)}</div>
            </div>
          ))
        )}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={handleSubmit}>
        <input
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="e.g. In Catan, can I trade with the bank on another player's turn?"
          aria-label="Rules question"
        />
        {isStreaming ? (
          <button type="button" onClick={() => stop()}>
            Stop
          </button>
        ) : (
          <button type="submit" disabled={!input.trim()}>
            Send
          </button>
        )}
      </form>
    </div>
  );
}
