import { type FormEvent, useEffect, useRef, useState } from "react";
import type { Citation, GameSummary, RulesUIMessage } from "../shared/types";
import { GoblinAvatar } from "./Goblin";
import { citationsOf, sourceLabel, textOf } from "./theme";

interface Props {
  game: GameSummary;
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

/** The per-Game chat: the goblin's ledger of questions, each ruling cited to the page. */
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
  const threadRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keep the latest turn in view as it streams.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, isStreaming]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    onSend(text);
  }

  const turns = messages.filter((m) => m.role === "user").length;
  const turnLabel =
    turns === 0 ? "New session" : turns === 1 ? "1 question asked" : `${turns} questions asked`;

  const last = messages[messages.length - 1];
  const awaiting =
    isStreaming &&
    (!last || last.role === "user" || (last.role === "assistant" && textOf(last).trim() === ""));

  return (
    <div className="chat">
      <div className="chathead">
        <button type="button" className="chathead__back" onClick={onBack}>
          ← Games
        </button>
        <span className="chathead__game">★ {game.name}</span>
        <span className="chathead__right">
          <button
            type="button"
            className="chathead__new"
            onClick={onNewConversation}
            disabled={messages.length === 0}
          >
            New
          </button>
          <span className="chathead__turns">{turnLabel}</span>
        </span>
      </div>

      <div className="thread" ref={threadRef}>
        {messages.length === 0 ? (
          <div className="turn turn--goblin">
            <GoblinAvatar className="turn__avatar" />
            <div className="bubble bubble--goblin">
              <div className="bubble__label">◆ The Goblin</div>
              <div className="bubble__ruling">
                Welcome to my parlour, seeker. Ask me anything about <strong>{game.name}</strong> —
                rules, rulings, the lot — and I shall cite you the very page.
              </div>
            </div>
          </div>
        ) : (
          messages.map((message) => {
            if (message.role === "user") {
              return (
                <div key={message.id} className="turn turn--you">
                  <div className="turn__tag">You asked</div>
                  <div className="bubble bubble--you">{textOf(message)}</div>
                </div>
              );
            }

            const text = textOf(message);
            if (text.trim() === "" && citationsOf(message).length === 0) return null;
            const cites = citationsOf(message);
            const isSpeaking = speakingId === message.id;
            const isLoading = loadingId === message.id;
            return (
              <div key={message.id} className="turn turn--goblin">
                <GoblinAvatar className="turn__avatar" />
                <div className="bubble bubble--goblin">
                  <div className="bubble__label">◆ The Goblin</div>
                  <div className="bubble__ruling">{text}</div>

                  {cites.length > 0 ? (
                    <div className="cited">
                      <span className="cited__label">Cited:</span>
                      {cites.map((citation, i) => {
                        const page = sourceLabel(citation);
                        return (
                          <button
                            key={citation.chunkId}
                            type="button"
                            className="citechip"
                            onClick={() => onOpenCitation(citation, i + 1)}
                          >
                            <span className="citechip__n">[{i + 1}]</span>
                            <span className="citechip__spine" aria-hidden="true" />
                            <span className="citechip__title">{citation.documentTitle}</span>
                            {page ? <span className="citechip__page">{page}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}

                  {text.trim() !== "" ? (
                    errorId === message.id ? (
                      <span className="hear hear--error" role="alert">
                        🔇 the goblin couldn't read that aloud
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="hear"
                        onClick={() => onToggleSpeak(message.id)}
                        disabled={isStreaming || (loadingId !== null && !isLoading)}
                        aria-label={isSpeaking ? "Stop reading" : "Read this ruling aloud"}
                      >
                        {isSpeaking ? (
                          <>
                            <span className="hear__wave" aria-hidden="true">
                              <span />
                              <span />
                              <span />
                              <span />
                            </span>
                            Speaking…
                          </>
                        ) : isLoading ? (
                          "Summoning his voice…"
                        ) : (
                          <>
                            <span className="hear__play" aria-hidden="true" />
                            Hear it read aloud
                          </>
                        )}
                      </button>
                    )
                  ) : null}
                </div>
              </div>
            );
          })
        )}

        {awaiting ? (
          <div className="turn turn--goblin">
            <GoblinAvatar className="turn__avatar" />
            <div className="thinking">
              <span className="thinking__dot" />
              <span className="thinking__dot" />
              <span className="thinking__dot" />
              <span className="thinking__text">thumbing the tome…</span>
            </div>
          </div>
        ) : null}
      </div>

      <form className="composer" onSubmit={submit}>
        <input
          className="composer__input"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={`Ask the goblin a ${game.name} rules question…`}
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
