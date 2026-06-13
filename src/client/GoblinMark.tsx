/**
 * The Rules Goblin — the app's mascot, rendered as an inline SVG so it tints to `currentColor`
 * (set to each Game's `--game-accent`). Facial features use `--goblin-ink` / `--goblin-tooth`
 * with sensible fallbacks, so the same mark works on a tile, an avatar, and the favicon.
 */
export function GoblinMark({ className, title }: { className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label={title ?? "The Rules Goblin"}
      xmlns="http://www.w3.org/2000/svg"
    >
      {title ? <title>{title}</title> : null}
      {/* skin: ears + head, one colour so it tints cleanly */}
      <g fill="currentColor" stroke="var(--goblin-ink, #16130f)" strokeWidth="2.5">
        <path d="M31 42 L7 21 Q11 47 31 53 Z" strokeLinejoin="round" />
        <path d="M69 42 L93 21 Q89 47 69 53 Z" strokeLinejoin="round" />
        <path
          d="M50 20 C70 20 82 35 82 56 C82 78 67 90 50 90 C33 90 18 78 18 56 C18 35 30 20 50 20 Z"
          strokeLinejoin="round"
        />
      </g>
      {/* angled, mischievous eyes */}
      <g fill="var(--goblin-ink, #16130f)">
        <path d="M31 50 Q41 44 49 51 Q40 56 31 50 Z" />
        <path d="M51 51 Q59 44 69 50 Q60 56 51 51 Z" />
        <circle cx="41" cy="50" r="2.1" fill="var(--goblin-tooth, #efe6d0)" />
        <circle cx="60" cy="50" r="2.1" fill="var(--goblin-tooth, #efe6d0)" />
      </g>
      {/* pointed nose */}
      <path d="M50 55 L45 67 L55 67 Z" fill="var(--goblin-ink, #16130f)" />
      {/* wide grin */}
      <path
        d="M34 72 Q50 86 66 72"
        fill="none"
        stroke="var(--goblin-ink, #16130f)"
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* a single proud fang */}
      <path d="M54 74 L58 74 L56 82 Z" fill="var(--goblin-tooth, #efe6d0)" />
    </svg>
  );
}
