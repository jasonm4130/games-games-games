import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import type { Citation, RulesUIMessage } from "../shared/types";
import { GoblinMark } from "./GoblinMark";
import { accentFor, citationsOf, pageLabel, textOf } from "./theme";

interface Game {
  id: string;
  name: string;
  edition: string | null;
}

interface Props {
  game: Game;
  messages: RulesUIMessage[];
  isStreaming: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onNewConversation: () => void;
  onBack: () => void;
  onOpenCitation: (citation: Citation, n: number) => void;
  onToggleSpeak: (id: string) => void;
  speakingId: string | null;
  loadingId: string | null;
  errorId: string | null;
}

/** The per-Game chat — the goblin tending one rulebook, themed to that Game's accent. */
export function Chat({
  game,
  messages,
  isStreaming,
  onSend,
  onStop,
  onNewConversation,
  onBack,
  onOpenCitation,
  onToggleSpeak,
  speakingId,
  loadingId,
  errorId,
}: Props) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the latest turn in view as messages stream.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    onSend(text);
  }

  return (
    <div className="chat-screen" style={{ "--game-accent": accentFor(game.id) } as CSSProperties}>
      <header className="chat-head">
        <button type="button" className="chat-head__back" onClick={onBack}>
          ◀ Parlour
        </button>
        <div className="chat-head__game">
          <GoblinMark className="chat-head__goblin" />
          <span className="chat-head__name">{game.name}</span>
          {game.edition ? <span className="chat-head__edition">{game.edition} ed.</span> : null}
        </div>
        <button
          type="button"
          className="chat-head__new"
          onClick={onNewConversation}
          disabled={messages.length === 0}
        >
          New conversation
        </button>
      </header>

      <main className="reel">
        {messages.length === 0 ? (
          <div className="reel__welcome">
            <GoblinMark className="reel__welcome-goblin" />
            <p>
              The goblin guards the <strong>{game.name}</strong> rulebook. Ask him anything — he
              answers straight from the text and shows you the page.
            </p>
          </div>
        ) : (
          messages.map((message) => {
            const cites = message.role === "assistant" ? citationsOf(message) : [];
            const isGoblin = message.role === "assistant";
            return (
              <article key={message.id} className={`turn turn--${isGoblin ? "goblin" : "player"}`}>
                {isGoblin ? <GoblinMark className="turn__avatar" /> : null}
                <div className="turn__bubble">
                  {isGoblin ? <span className="turn__stamp">Ruling</span> : null}
                  {isGoblin ? (
                    <button
                      type="button"
                      className="turn__speak"
                      onClick={() => onToggleSpeak(message.id)}
                      disabled={isStreaming || (loadingId !== null && loadingId !== message.id)}
                      aria-label={
                        speakingId === message.id ? "Stop reading" : "Read this ruling aloud"
                      }
                    >
                      {speakingId === message.id ? "⏹" : loadingId === message.id ? "…" : "🔊"}
                    </button>
                  ) : null}
                  {isGoblin && errorId === message.id ? (
                    <span className="turn__voice-error" role="alert">
                      🔇 the goblin couldn't read that aloud
                    </span>
                  ) : null}
                  <div className="turn__body">{textOf(message)}</div>
                  {cites.length > 0 ? (
                    <div className="cite-row">
                      {cites.map((citation, i) => {
                        const page = pageLabel(citation);
                        return (
                          <button
                            key={citation.chunkId}
                            type="button"
                            className="cite-chip"
                            onClick={() => onOpenCitation(citation, i + 1)}
                          >
                            <span className="cite-chip__n">[{i + 1}]</span>
                            <span className="cite-chip__meta">
                              {citation.documentTitle}
                              {page ? ` · ${page}` : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
        {isStreaming ? (
          <div className="goblin-thinking">
            <GoblinMark className="goblin-thinking__mark" />
            <span>the goblin flips pages…</span>
          </div>
        ) : null}
        <div ref={endRef} />
      </main>

      <form className="composer" onSubmit={submit}>
        <input
          className="composer__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={`Ask about ${game.name}…`}
          aria-label="Rules question"
        />
        {isStreaming ? (
          <button type="button" className="composer__btn composer__btn--stop" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="composer__btn" disabled={!input.trim()}>
            Ask
          </button>
        )}
      </form>
    </div>
  );
}
