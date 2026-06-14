import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { useEffect, useState } from "react";
import type { RulesAgent } from "../server/agent";
import type { Citation, RulesAgentState, RulesUIMessage } from "../shared/types";
import { Catalogue } from "./Catalogue";
import { Chat } from "./Chat";
import { CitationModal } from "./CitationModal";
import { useGoblinVoice } from "./useGoblinVoice";

interface Game {
  id: string;
  name: string;
  edition: string | null;
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
  const [games, setGames] = useState<Game[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"catalogue" | "chat">("catalogue");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activeCite, setActiveCite] = useState<{ citation: Citation; n: number } | null>(null);
  const [sessionName] = useState(getSessionId);

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

  // Goblin TTS rides the authenticated agent WebSocket (no public route): the hook calls the
  // `speak` RPC, which returns the ruling's audio as base64 (or an in-character failure reason).
  const voice = useGoblinVoice((id) => agent.stub.speak(id));

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
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Enter a Game's chat. Switching to a different Game starts a fresh conversation; re-entering
  // the active one keeps its history. `selectedId` drives the view immediately so there's no
  // flicker waiting for the agent's activeGameId state to round-trip.
  function enterGame(id: string) {
    if (id !== activeGameId) clearHistory();
    setSelectedId(id);
    agent.stub.selectGame(id);
    setView("chat");
  }

  const selectedGame = games.find((game) => game.id === selectedId) ?? null;

  return (
    <>
      {view === "chat" && selectedGame ? (
        <Chat
          game={selectedGame}
          messages={messages}
          isStreaming={isStreaming}
          onSend={(text) => {
            voice.stop();
            sendMessage({ role: "user", parts: [{ type: "text", text }] });
          }}
          onStop={() => stop()}
          onNewConversation={() => {
            voice.stop();
            clearHistory();
          }}
          onBack={() => {
            voice.stop();
            setView("catalogue");
          }}
          onOpenCitation={(citation, n) => setActiveCite({ citation, n })}
          onToggleSpeak={voice.toggle}
          speakingId={voice.speakingId}
          loadingId={voice.loadingId}
          errorId={voice.errorId}
        />
      ) : (
        <Catalogue games={games} ready={loaded} onPick={enterGame} />
      )}
      {activeCite ? (
        <CitationModal
          citation={activeCite.citation}
          n={activeCite.n}
          onClose={() => setActiveCite(null)}
        />
      ) : null}
    </>
  );
}
