import type { ReactNode } from "react";
import { GoblinStage } from "./Goblin";

interface Props {
  /** The mono pill in the masthead, e.g. "Pick a game" or "In session · Catan". */
  stepLabel: string;
  /** The italic line the goblin "says" from the speech ribbon, scoped to the current view. */
  ribbon: string;
  /** Opens the stage goblin's mouth while a ruling is read aloud. */
  speaking: boolean;
  children: ReactNode;
}

/**
 * The persistent parlour shell shared by the picker and the chat: masthead, a sticky left stage
 * with the bobbing goblin and his speech ribbon, and a right panel slot for the active view.
 */
export function Parlour({ stepLabel, ribbon, speaking, children }: Props) {
  return (
    <div className="shell">
      <div className="shell__inner">
        <header className="masthead">
          <div className="brand">
            <div className="emblem">
              <div className="emblem__dot" />
            </div>
            <h1 className="wordmark">
              <span>The Goblin's</span>
              <span>Game Parlour</span>
            </h1>
          </div>
          <div className="masthead__meta">
            <p className="masthead__tag">
              Rules, kept
              <br />
              by a goblin
            </p>
            <div className="steppill">{stepLabel}</div>
          </div>
        </header>

        <main className="stagewrap">
          <section className="stage-col">
            <div className="stage">
              <div className="stage__halftone" aria-hidden="true" />
              <span className="stage__spark" aria-hidden="true">
                ✦
              </span>
              <span className="stage__spark stage__spark--tw" aria-hidden="true">
                ✦
              </span>
              <GoblinStage speaking={speaking} />
            </div>

            <div className="ribbon">
              <div className="ribbon__tail" aria-hidden="true" />
              <div className="ribbon__label">◆ The Goblin says</div>
              <p className="ribbon__text">{ribbon}</p>
            </div>
          </section>

          <section className="panel-col">{children}</section>
        </main>
      </div>
    </div>
  );
}
