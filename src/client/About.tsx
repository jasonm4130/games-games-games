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
    <div className="about-page">
      <div className="about-page__inner">
        <button type="button" className="about-page__back" onClick={onBack}>
          ◂ Back to the shelf
        </button>

        <header className="about-page__head">
          <div className="emblem">
            <div className="emblem__dot" />
          </div>
          <h1 className="about-page__title">About the Parlour</h1>
          <p className="about-page__tag">
            A Rules Goblin who has actually read the rulebook — and always shows you the page.
          </p>
        </header>

        <div className="about-page__cards">
          <section className="about-card">
            <h2 className="about-card__h">What is this?</h2>
            <p>
              Ask the goblin a rules question about any of the{" "}
              {gameCount > 0 ? `${gameCount} games` : "games"} on the shelf and he answers from the{" "}
              <em>actual rulebook</em>, quoting the passage he relied on. No invented rules, no "I
              think" — every ruling is grounded in the text and cited so you can check it.
            </p>
          </section>

          <section className="about-card">
            <h2 className="about-card__h">How the goblin knows</h2>
            <ol className="about-card__steps">
              <li>
                Each rulebook is converted to clean, heading-aware text and split into small
                passages.
              </li>
              <li>Every passage is embedded into a vector index (Cloudflare Vectorize).</li>
              <li>
                Your question fetches candidates two ways — semantic vector search and keyword
                (BM25) search — which are fused and re-ranked down to the most relevant few.
              </li>
              <li>
                A language model writes the answer from <em>only</em> those passages, with a
                citation you can open to read the source rule yourself.
              </li>
            </ol>
          </section>

          <section className="about-card">
            <h2 className="about-card__h">Built with</h2>
            <p className="about-card__stack">
              Cloudflare Workers · Durable Objects (Agents SDK) · Vectorize · D1 · R2 · Workers AI
              (bge-m3 embeddings, Llama 3.3 70B) · Hono · Drizzle · React · Vite
            </p>
            <p>
              It's open source —{" "}
              <a className="about-card__link" href={REPO_URL} target="_blank" rel="noreferrer">
                read the code on GitHub ▸
              </a>
            </p>
          </section>

          <section className="about-card about-card--cta">
            <h2 className="about-card__h">Don't see your game?</h2>
            <p>The hoard is always growing. Tell the goblin which rulebook to devour next.</p>
            <a className="about-card__request" href={REQUEST_URL} target="_blank" rel="noreferrer">
              Request a game ▸
            </a>
          </section>
        </div>

        <footer className="about-page__foot">
          Grounded answers, with citations. No rules lawyering.
        </footer>
      </div>
    </div>
  );
}
