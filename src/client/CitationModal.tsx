import { useEffect, useRef } from "react";
import type { Citation } from "../shared/types";
import { GoblinMark } from "./GoblinMark";
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

  return (
    <div className="cite-modal__wrap">
      {/* Sibling button (not a wrapping div) so backdrop-dismiss is keyboard-accessible. */}
      <button
        type="button"
        className="cite-modal__backdrop"
        aria-label="Close passage"
        onClick={onClose}
      />
      <div
        className="cite-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cite-modal-title"
      >
        <header className="cite-modal__head">
          <span className="cite-modal__kicker">From the rulebook</span>
          <h2 id="cite-modal-title" className="cite-modal__title">
            <span className="cite-modal__n">[{n}]</span>
            {citation.gameName}
            {page ? <span className="cite-modal__page"> · {page}</span> : null}
          </h2>
          <button
            ref={closeRef}
            type="button"
            className="cite-modal__close"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </header>
        <div className="cite-modal__sheet">
          <p className="cite-modal__text">{citation.text}</p>
        </div>
        <footer className="cite-modal__foot">
          <GoblinMark className="cite-modal__goblin" />
          <span>Straight from the goblin's hoard — nothing added, nothing left out.</span>
        </footer>
      </div>
    </div>
  );
}
