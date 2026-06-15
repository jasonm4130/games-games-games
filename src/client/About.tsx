import { GoblinMark } from "./GoblinMark";

const REPO_URL = "https://github.com/jasonm4130/games-games-games";
const REQUEST_URL = `${REPO_URL}/issues/new?template=game-request.md`;

interface Props {
  /** Live catalogue size, for the "N games on the shelf" line. */
  gameCount: number;
  onBack: () => void;
}

/** The parlour's back room: what the app is, how the grounded answers work, and how to request a game. */
export function About({ gameCount, onBack }: Props) {
  return (
    <div className="parlour about">
      <nav className="parlour__nav">
        <button type="button" className="parlour__navlink" onClick={onBack}>
          ◂ Back to the shelf
        </button>
      </nav>

      <header className="parlour__masthead">
        <GoblinMark className="parlour__emblem" title="The Rules Goblin" />
        <h1 className="parlour__wordmark">
          <span>About the</span>
          <span>Parlour</span>
        </h1>
        <p className="parlour__tagline">
          A Rules Goblin who has actually read the rulebook — and always shows you the page.
        </p>
      </header>

      <div className="about__sheet">
        <section className="about__card">
          <h2 className="about__h">What is this?</h2>
          <p>
            Ask the goblin a rules question about any of the{" "}
            {gameCount > 0 ? `${gameCount} games` : "games"} on the shelf and he answers from the{" "}
            <em>actual rulebook</em>, quoting the passage he relied on. No invented rules, no "I
            think" — every ruling is grounded in the text and cited so you can check it.
          </p>
        </section>

        <section className="about__card">
          <h2 className="about__h">How the goblin knows</h2>
          <ol className="about__steps">
            <li>
              Each rulebook is converted to clean, heading-aware text and split into small passages.
            </li>
            <li>Every passage is embedded into a vector index (Cloudflare Vectorize).</li>
            <li>
              Your question fetches candidates two ways — semantic vector search and keyword (BM25)
              search — which are fused and re-ranked down to the most relevant few.
            </li>
            <li>
              A language model writes the answer from <em>only</em> those passages, with a citation
              you can open to read the source rule yourself.
            </li>
          </ol>
        </section>

        <section className="about__card">
          <h2 className="about__h">Built with</h2>
          <p className="about__stack">
            Cloudflare Workers · Durable Objects (Agents SDK) · Vectorize · D1 · R2 · Workers AI
            (bge-m3 embeddings, Llama 3.3 70B) · Hono · Drizzle · React · Vite
          </p>
          <p>
            It's open source —{" "}
            <a className="about__link" href={REPO_URL} target="_blank" rel="noreferrer">
              read the code on GitHub ▸
            </a>
          </p>
        </section>

        <section className="about__card about__card--cta">
          <h2 className="about__h">Don't see your game?</h2>
          <p>The hoard is always growing. Tell the goblin which rulebook to devour next.</p>
          <a className="about__request" href={REQUEST_URL} target="_blank" rel="noreferrer">
            Request a game ▸
          </a>
        </section>
      </div>

      <footer className="parlour__foot">
        Grounded answers, with citations. No rules lawyering.
      </footer>
    </div>
  );
}
