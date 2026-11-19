import { Check, OctagonAlert } from "lucide-react";
import type { ActionPlan } from "../types";

export default function PlanTracker({ plan }: { plan: ActionPlan | null }) {
  if (!plan)
    return (
      <aside className="card plan plan--empty">
        <h2 className="label">🗺️ Plan</h2>
        <div className="plan__placeholder">
          <span className="skeleton" />
          <span className="skeleton skeleton--short" />
          <span className="skeleton" />
        </div>
        <p className="muted small">The agent's first move is always to write a plan.</p>
      </aside>
    );

  const done = plan.steps.filter((step) => step.status === "completed").length;
  const percent = Math.round((done / plan.steps.length) * 100);
  return (
    <aside className="card plan" aria-live="polite">
      <div className="plan__head">
        <h2 className="label">🗺️ Plan</h2>
        <span className={`badge badge--${plan.status}`}>
          {plan.status === "completed" ? "done" : `${done}/${plan.steps.length}`}
        </span>
      </div>
      <div className="plan__meter" aria-hidden>
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="plan__goal">{plan.goal}</p>
      <ol className="stepper">
        {plan.steps.map((step, index) => (
          <li key={step.id} className={`stepper__step stepper__step--${step.status}`}>
            <span className="stepper__dot">
              {step.status === "completed" ? (
                <Check size={12} strokeWidth={3} aria-hidden />
              ) : step.status === "blocked" ? (
                <OctagonAlert size={12} aria-hidden />
              ) : (
                index + 1
              )}
            </span>
            <div className="stepper__text">
              <span className="stepper__title">{step.title}</span>
              {step.note && <span className="stepper__note">{step.note}</span>}
            </div>
          </li>
        ))}
      </ol>
    </aside>
  );
}
