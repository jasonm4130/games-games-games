import type { CSSProperties } from "react";
import { GoblinMark } from "./GoblinMark";
import { accentFor } from "./theme";

interface Game {
  id: string;
  name: string;
  edition: string | null;
}

interface Props {
  games: Game[];
  /** True once listGames has resolved — distinguishes "loading" from a genuinely empty shelf. */
  ready: boolean;
  onPick: (id: string) => void;
}

/** The landing page: the goblin's parlour, with each Game as a piece of box art on the shelf. */
export function Catalogue({ games, ready, onPick }: Props) {
  return (
    <div className="parlour">
      <header className="parlour__masthead">
        <GoblinMark className="parlour__emblem" title="The Rules Goblin" />
        <h1 className="parlour__wordmark">
          <span>The Goblin's</span>
          <span>Game Parlour</span>
        </h1>
        <p className="parlour__tagline">
          Pick a game and ask the goblin. He has read every rulebook in the hoard — and he will
          always show you the page.
        </p>
      </header>

      {games.length === 0 ? (
        <p className="parlour__empty">
          {ready
            ? "The shelf is bare — no games have been onboarded yet."
            : "Prising open the goblin's cabinet…"}
        </p>
      ) : (
        <ul className="parlour__grid">
          {games.map((game, i) => (
            <li
              key={game.id}
              className="parlour__cell"
              style={{ animationDelay: `${i * 80}ms` } as CSSProperties}
            >
              <button
                type="button"
                className="gamebox"
                style={{ "--game-accent": accentFor(game.id) } as CSSProperties}
                onClick={() => onPick(game.id)}
              >
                <span className="gamebox__spine" />
                <span className="gamebox__art">
                  <GoblinMark className="gamebox__goblin" />
                  {game.edition ? (
                    <span className="gamebox__sticker">{game.edition} ed.</span>
                  ) : null}
                </span>
                <span className="gamebox__plate">
                  <span className="gamebox__name">{game.name}</span>
                  <span className="gamebox__cta">Consult the goblin →</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <footer className="parlour__foot">
        Grounded answers, with citations. No rules lawyering.
      </footer>
    </div>
  );
}
