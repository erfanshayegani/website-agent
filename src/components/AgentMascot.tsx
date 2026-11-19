// Cartoon mascot for the model card: a little devil-horned robot that
// sleeps, wakes up, works on tasks and asks questions along with the agent.
export type MascotState = "asleep" | "waking" | "awake" | "working" | "asking";

export default function AgentMascot({ state, size = 64 }: { state: MascotState; size?: number }) {
  return (
    <span className={`mascot mascot--${state}`} style={{ width: size, height: size }} aria-hidden>
      {state === "asleep" && <span className="mascot__bubble">Zzz…</span>}
      {state === "working" && (
        <span className="mascot__bubble mascot__bubble--think">
          <i />
          <i />
          <i />
        </span>
      )}
      {state === "asking" && <span className="mascot__bubble mascot__bubble--ask">?</span>}
      <svg className="mascot__body" viewBox="0 0 100 100">
        {/* horns */}
        <path className="mascot__horn" d="M27 30 L19 7 L41 24 Z" />
        <path className="mascot__horn" d="M73 30 L81 7 L59 24 Z" />
        {/* head */}
        <rect className="mascot__head" x="12" y="22" width="76" height="68" rx="22" />
        <rect className="mascot__shine" x="20" y="28" width="22" height="9" rx="4.5" />

        {state === "asleep" && (
          <g className="mascot__face">
            <path d="M28 55 q9 9 18 0" />
            <path d="M54 55 q9 9 18 0" />
            <path d="M44 74 q6 4 12 0" />
          </g>
        )}

        {state === "waking" && (
          <g className="mascot__face">
            {/* one eye half open, one squinting */}
            <path d="M28 56 h18" />
            <ellipse className="mascot__fill" cx="63" cy="55" rx="7" ry="4" />
            {/* yawn */}
            <ellipse className="mascot__fill" cx="50" cy="74" rx="7" ry="8" />
          </g>
        )}

        {state === "working" && (
          <g className="mascot__face">
            {/* friendly eyes that follow the magnifier */}
            <g className="mascot__look">
              <ellipse className="mascot__fill" cx="38" cy="52" rx="6.5" ry="8" />
              <ellipse className="mascot__fill" cx="62" cy="52" rx="6.5" ry="8" />
              <circle className="mascot__glint" cx="40.5" cy="48.5" r="2.2" />
              <circle className="mascot__glint" cx="64.5" cy="48.5" r="2.2" />
            </g>
            <circle className="mascot__cheek" cx="24" cy="67" r="5" />
            <circle className="mascot__cheek" cx="76" cy="67" r="5" />
            <path d="M40 69 q10 9 20 0" />
            {/* magnifying glass, sweeping around */}
            <g className="mascot__magnifier">
              <line className="mascot__handle" x1="80" y1="84" x2="95" y2="99" />
              <circle className="mascot__lens" cx="70" cy="74" r="14" />
              <path className="mascot__lens-glint" d="M61 70 q2 -7 9 -9" />
            </g>
          </g>
        )}

        {state === "asking" && (
          <g className="mascot__face">
            <ellipse className="mascot__fill" cx="37" cy="53" rx="7" ry="9" />
            <ellipse className="mascot__fill" cx="63" cy="51" rx="7" ry="10" />
            <circle className="mascot__glint" cx="39.5" cy="49.5" r="2.4" />
            <circle className="mascot__glint" cx="65.5" cy="47" r="2.4" />
            <ellipse className="mascot__fill" cx="50" cy="74" rx="4.5" ry="5" />
          </g>
        )}

        {state === "awake" && (
          <g className="mascot__face">
            <g className="mascot__eyes">
              <ellipse className="mascot__fill" cx="37" cy="53" rx="7" ry="9" />
              <ellipse className="mascot__fill" cx="63" cy="53" rx="7" ry="9" />
              <circle className="mascot__glint" cx="39.5" cy="49.5" r="2.4" />
              <circle className="mascot__glint" cx="65.5" cy="49.5" r="2.4" />
            </g>
            <circle className="mascot__cheek" cx="24" cy="68" r="5" />
            <circle className="mascot__cheek" cx="76" cy="68" r="5" />
            <path d="M37 70 q13 13 26 0" />
          </g>
        )}
      </svg>
    </span>
  );
}
