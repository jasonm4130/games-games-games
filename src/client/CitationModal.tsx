import { useEffect, useRef } from "react";
import type { Citation } from "../shared/types";
import { pageLabel } from "./theme";

interface Props {
  citation: Citation;
  /** The 1-based [N] marker this Citation was rendered under. */
  n: number;
  onClose: () => void;
}

/**
 * The full retrieved passage, presented as a torn-out rulebook page. Opened from a citation
 * chip in the chat. Accessible modal: labelled dialog, Escape + backdrop dismiss, focus moved
 * to the close button on open and restored to the trigger on close, body scroll locked while up.
 */
export function CitationModal({ citation, n, onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = priorOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const page = pageLabel(citation);
  const section = citation.headingPath ?? "";
  const paragraphs = citation.text.split(/\n+/).filter((line) => line.trim() !== "");

  return (
    <div className="sheet-modal__wrap">
      {/* Sibling button (not a wrapping div) so backdrop-dismiss is keyboard-accessible. */}
      <button
        type="button"
        className="sheet-modal__scrim"
        aria-label="Close passage"
        onClick={onClose}
      />
      <div
        className="sheet-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sheet-modal-title"
      >
        <header className="sheet-modal__head">
          <div className="sheet-modal__headtext">
            <span className="sheet-modal__kicker">Retrieved from the rulebook</span>
            <h2 id="sheet-modal-title" className="sheet-modal__book">
              {citation.documentTitle}
            </h2>
            <div className="sheet-modal__meta">
              <span className="sheet-modal__tab">{citation.gameName}</span>
              <span className="sheet-modal__n">[{n}]</span>
              {page ? <span className="sheet-modal__page">{page}</span> : null}
            </div>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="sheet-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>

        <div className="sheet-modal__body">
          {section ? (
            <>
              <div className="sheet-modal__heading">{section.split(" › ").pop()}</div>
              <div className="sheet-modal__section">
                § {section} · {citation.gameName}
              </div>
            </>
          ) : null}
          {paragraphs.map((line, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: passage lines are static and order-stable.
            <p key={i} className="sheet-modal__p">
              {line}
            </p>
          ))}
        </div>

        <footer className="sheet-modal__foot">
          <div className="sheet-modal__goblin" aria-hidden="true">
            <div className="sheet-modal__goblin-head" />
            <div className="sheet-modal__goblin-eye sheet-modal__goblin-eye--l" />
            <div className="sheet-modal__goblin-eye sheet-modal__goblin-eye--r" />
          </div>
          <span className="sheet-modal__quote">
            “Straight from the goblin's hoard — nothing added, nothing left out.”
          </span>
        </footer>
      </div>
    </div>
  );
}
