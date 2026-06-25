import type { CSSProperties } from "react";

/**
 * The Rules Goblin, rebuilt as the design's hand-drawn CSS character (a tower of
 * pixel-positioned divs). The geometry is unique single-use art, so it stays inline rather than
 * exploding styles.css with one selector per limb; the named animations (bob/blink/pomsway/talk)
 * live in styles.css. Two sizes: GoblinStage is the big bobbing figure on the parlour stage,
 * GoblinAvatar the small peeking head beside each goblin chat turn.
 */

const INK = "#221d15";
const SKIN = "#5cab72";
const SKIN_EAR = "#56a46c";
const CREAM = "#fdfaf0";

const abs: CSSProperties = { position: "absolute" };

/** The big bobbing goblin on the stage. `speaking` opens the mouth while a ruling is read aloud. */
export function GoblinStage({ speaking = false }: { speaking?: boolean }) {
  return (
    <div
      aria-hidden="true"
      style={{
        position: "relative",
        width: "260px",
        height: "300px",
        animation: "bob 4.2s ease-in-out infinite",
      }}
    >
      {/* ears */}
      <div
        style={{
          ...abs,
          left: "14px",
          top: "98px",
          width: "56px",
          height: "46px",
          background: SKIN_EAR,
          border: `3px solid ${INK}`,
          borderRadius: "62% 8% 62% 62%",
          transform: "rotate(-18deg)",
          zIndex: 1,
        }}
      />
      <div
        style={{
          ...abs,
          left: "188px",
          top: "98px",
          width: "56px",
          height: "46px",
          background: SKIN_EAR,
          border: `3px solid ${INK}`,
          borderRadius: "8% 62% 62% 62%",
          transform: "rotate(18deg)",
          zIndex: 1,
        }}
      />
      {/* head */}
      <div
        style={{
          ...abs,
          left: "42px",
          top: "74px",
          width: "176px",
          height: "152px",
          background: SKIN,
          border: `4px solid ${INK}`,
          borderRadius: "48% 48% 46% 46% / 54% 54% 46% 46%",
          zIndex: 2,
        }}
      />
      {/* cheek blush */}
      <div
        style={{
          ...abs,
          left: "60px",
          top: "168px",
          width: "30px",
          height: "18px",
          background: "#ee6a4d",
          opacity: 0.5,
          borderRadius: "50%",
          zIndex: 3,
          filter: "blur(2px)",
        }}
      />
      <div
        style={{
          ...abs,
          left: "170px",
          top: "168px",
          width: "30px",
          height: "18px",
          background: "#ee6a4d",
          opacity: 0.5,
          borderRadius: "50%",
          zIndex: 3,
          filter: "blur(2px)",
        }}
      />
      {/* hat brim + band */}
      <div
        style={{
          ...abs,
          left: "48px",
          top: "54px",
          width: "164px",
          height: "48px",
          background: "#ee6a4d",
          border: `3px solid ${INK}`,
          borderRadius: "80px 80px 18px 18px",
          zIndex: 3,
        }}
      />
      <div
        style={{
          ...abs,
          left: "46px",
          top: "92px",
          width: "168px",
          height: "14px",
          background: "#d4512f",
          border: `3px solid ${INK}`,
          borderRadius: "8px",
          zIndex: 3,
        }}
      />
      {/* hat cone + swaying pom */}
      <div
        style={{
          ...abs,
          left: "196px",
          top: "30px",
          width: "26px",
          height: "50px",
          background: "#ee6a4d",
          border: `3px solid ${INK}`,
          borderRadius: "50%",
          transform: "rotate(30deg)",
          transformOrigin: "bottom center",
          zIndex: 3,
        }}
      >
        <div
          style={{
            ...abs,
            left: "-9px",
            top: "-20px",
            width: "22px",
            height: "22px",
            background: "#e8b04b",
            border: `3px solid ${INK}`,
            borderRadius: "50%",
            animation: "pomsway 2.8s ease-in-out infinite",
            transformOrigin: "bottom center",
          }}
        />
      </div>
      {/* eyebrows */}
      <div
        style={{
          ...abs,
          left: "73px",
          top: "106px",
          width: "34px",
          height: "7px",
          background: INK,
          borderRadius: "5px",
          transform: "rotate(-15deg)",
          zIndex: 5,
        }}
      />
      <div
        style={{
          ...abs,
          left: "151px",
          top: "110px",
          width: "34px",
          height: "7px",
          background: INK,
          borderRadius: "5px",
          transform: "rotate(9deg)",
          zIndex: 5,
        }}
      />
      {/* eyes (white, pupil + glint, blinking lid) */}
      <StageEye left="74px" blinkDelay="0s" />
      <StageEye left="150px" blinkDelay="0.15s" />
      {/* nose */}
      <div
        style={{
          ...abs,
          left: "107px",
          top: "150px",
          width: "46px",
          height: "44px",
          background: "#479060",
          border: `3px solid ${INK}`,
          borderRadius: "48% 48% 56% 56%",
          zIndex: 5,
        }}
      />
      {/* resting mouth with teeth */}
      <div
        style={{
          ...abs,
          left: "104px",
          top: "200px",
          width: "52px",
          height: "26px",
          background: "#7a2f37",
          border: `3px solid ${INK}`,
          borderTop: "none",
          borderRadius: "0 0 30px 30px",
          zIndex: 5,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            ...abs,
            left: "5px",
            top: "-3px",
            width: "9px",
            height: "11px",
            background: CREAM,
            border: `2px solid ${INK}`,
            borderRadius: "0 0 50% 50%",
          }}
        />
        <div
          style={{
            ...abs,
            right: "5px",
            top: "-3px",
            width: "9px",
            height: "11px",
            background: CREAM,
            border: `2px solid ${INK}`,
            borderRadius: "0 0 50% 50%",
          }}
        />
      </div>
      {/* talking mouth — only while a ruling is read aloud */}
      {speaking ? (
        <div
          style={{
            ...abs,
            left: "114px",
            top: "204px",
            width: "32px",
            height: "24px",
            background: "#7a2f37",
            border: `3px solid ${INK}`,
            borderRadius: "46%",
            zIndex: 6,
            animation: "talk .32s ease-in-out infinite",
          }}
        />
      ) : null}
      {/* the guarded tome */}
      <div
        style={{ ...abs, left: "60px", top: "230px", width: "140px", height: "62px", zIndex: 7 }}
      >
        <div
          style={{
            ...abs,
            inset: 0,
            background: "#2f7d4f",
            border: `3px solid ${INK}`,
            borderRadius: "6px 10px 10px 6px",
            boxShadow: `3px 4px 0 ${INK}`,
          }}
        />
        <div
          style={{
            ...abs,
            left: 0,
            top: 0,
            width: "13px",
            height: "100%",
            background: "#d4512f",
            borderRight: `3px solid ${INK}`,
            borderRadius: "6px 0 0 6px",
          }}
        />
        <div
          style={{
            ...abs,
            right: "5px",
            top: "5px",
            width: "8px",
            height: "calc(100% - 10px)",
            background: "#f3ead0",
            border: `2px solid ${INK}`,
          }}
        />
        <div
          style={{
            ...abs,
            left: "50%",
            top: "50%",
            width: "22px",
            height: "22px",
            transform: "translate(-50%,-50%) rotate(45deg)",
            background: "#e8b04b",
            border: `3px solid ${INK}`,
          }}
        />
      </div>
      {/* hands */}
      <div
        style={{
          ...abs,
          left: "48px",
          top: "248px",
          width: "30px",
          height: "24px",
          background: SKIN_EAR,
          border: `3px solid ${INK}`,
          borderRadius: "50% 50% 50% 60%",
          zIndex: 8,
        }}
      />
      <div
        style={{
          ...abs,
          left: "184px",
          top: "248px",
          width: "30px",
          height: "24px",
          background: SKIN_EAR,
          border: `3px solid ${INK}`,
          borderRadius: "50% 50% 60% 50%",
          zIndex: 8,
        }}
      />
    </div>
  );
}

function StageEye({ left, blinkDelay }: { left: string; blinkDelay: string }) {
  return (
    <div
      style={{
        ...abs,
        left,
        top: "120px",
        width: "36px",
        height: "42px",
        background: CREAM,
        border: `3px solid ${INK}`,
        borderRadius: "50%",
        overflow: "hidden",
        zIndex: 4,
      }}
    >
      <div
        style={{
          ...abs,
          left: "10px",
          top: "17px",
          width: "16px",
          height: "16px",
          background: INK,
          borderRadius: "50%",
        }}
      >
        <div
          style={{
            ...abs,
            left: "3px",
            top: "3px",
            width: "5px",
            height: "5px",
            background: CREAM,
            borderRadius: "50%",
          }}
        />
      </div>
      <div
        style={{
          ...abs,
          left: 0,
          top: 0,
          width: "100%",
          height: "100%",
          background: SKIN,
          transformOrigin: "top",
          transform: "scaleY(0)",
          animation: `blink 5s ease-in-out infinite ${blinkDelay}`,
        }}
      />
    </div>
  );
}

/** The small peeking goblin head beside each goblin chat turn (and the thinking indicator). */
export function GoblinAvatar({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{ position: "relative", width: "46px", height: "46px", flex: "0 0 auto" }}
    >
      <div
        style={{
          ...abs,
          left: "2px",
          top: "14px",
          width: "14px",
          height: "14px",
          background: SKIN_EAR,
          border: `2.5px solid ${INK}`,
          borderRadius: "60% 8% 60% 60%",
          transform: "rotate(-20deg)",
        }}
      />
      <div
        style={{
          ...abs,
          right: "2px",
          top: "14px",
          width: "14px",
          height: "14px",
          background: SKIN_EAR,
          border: `2.5px solid ${INK}`,
          borderRadius: "8% 60% 60% 60%",
          transform: "rotate(20deg)",
        }}
      />
      <div
        style={{
          ...abs,
          left: "6px",
          top: "4px",
          width: "34px",
          height: "38px",
          background: SKIN,
          border: `2.5px solid ${INK}`,
          borderRadius: "48% 48% 46% 46%",
        }}
      />
      <div
        style={{
          ...abs,
          left: "13px",
          top: "17px",
          width: "8px",
          height: "9px",
          background: CREAM,
          border: `2px solid ${INK}`,
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          ...abs,
          left: "25px",
          top: "17px",
          width: "8px",
          height: "9px",
          background: CREAM,
          border: `2px solid ${INK}`,
          borderRadius: "50%",
        }}
      />
      <div
        style={{
          ...abs,
          left: "18px",
          top: "24px",
          width: "10px",
          height: "10px",
          background: "#479060",
          border: `2px solid ${INK}`,
          borderRadius: "50% 50% 55% 55%",
        }}
      />
    </div>
  );
}
