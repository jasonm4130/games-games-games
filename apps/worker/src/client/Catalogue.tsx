import type { CSSProperties } from "react";
import type { GameSummary } from "../shared/types";
import { tokenColorFor } from "./theme";

interface Props {
  games: GameSummary[];
  /** True once listGames has resolved — distinguishes "loading" from a genuinely empty shelf. */
  ready: boolean;
  onPick: (id: string) => void;
  onAbout: () => void;
}

/** A stable token shape per hoard card — rotates three silhouettes for variety on the shelf. */
const TOKEN_SHAPES = ["9px", "50%", "9px 9px 9px 22px"];

function tokenShape(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return TOKEN_SHAPES[((hash % TOKEN_SHAPES.length) + TOKEN_SHAPES.length) % TOKEN_SHAPES.length];
}

/** The picker: the goblin's favourite as box art, with the rest of the hoard on the shelf below. */
export function Catalogue({ games, ready, onPick, onAbout }: Props) {
  const [featured, ...hoard] = games;

  return (
    <div className="picker">
      <h2 className="picker__title">Choose thy game</h2>
      <p className="picker__intro">
        Pick a game and the goblin throws open its rulebook — ask as many questions as you like.
        Every ruling comes with the very page.
      </p>

      {games.length === 0 ? (
        <p className="picker__empty">
          {ready
            ? "The shelf is bare — no games have been onboarded yet."
            : "Prising open the goblin's cabinet…"}
        </p>
      ) : (
        <>
          <button type="button" className="featured" onClick={() => onPick(featured.id)}>
            <span className="featured__token">
              <span className="featured__token-dot" />
            </span>
            <span className="featured__body">
              <span className="featured__kicker">★ The goblin's favourite</span>
              <span className="featured__name">{featured.name}</span>
              <span className="featured__blurb">
                {featured.edition
                  ? `${featured.edition} edition — every rule indexed, cited to the page.`
                  : "Every rule indexed — ask, and he cites you the page."}
              </span>
            </span>
            <span className="featured__enter">Enter →</span>
          </button>

          {hoard.length > 0 ? (
            <>
              <div className="picker__shelf-label">◆ More in the hoard</div>
              <div className="hoard">
                {hoard.map((game) => (
                  <button
                    type="button"
                    key={game.id}
                    className="hoardcard"
                    onClick={() => onPick(game.id)}
                  >
                    <span
                      className="hoardcard__token"
                      style={
                        {
                          background: tokenColorFor(game.id),
                          borderRadius: tokenShape(game.id),
                        } as CSSProperties
                      }
                    />
                    <span className="hoardcard__name">{game.name}</span>
                    <span className="hoardcard__meta">
                      {game.edition ? `${game.edition} ed.` : "In the hoard"}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : null}
        </>
      )}

      <button type="button" className="picker__about" onClick={onAbout}>
        About the parlour ▸
      </button>
    </div>
  );
}
