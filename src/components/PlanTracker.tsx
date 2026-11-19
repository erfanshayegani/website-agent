import { CheckCircle2, Circle, CircleDot, OctagonAlert } from "lucide-react";
import type { ActionPlan, StepStatus } from "../types";

const STATUS_ICON: Record<StepStatus, typeof Circle> = {
  pending: Circle,
  in_progress: CircleDot,
  completed: CheckCircle2,
  blocked: OctagonAlert,
};

export default function PlanTracker({ plan }: { plan: ActionPlan | null }) {
  if (!plan)
    return (
      <aside className="card plan plan--empty">
        <h2 className="label">Plan</h2>
        <p className="muted small">The agent creates its plan as its first step.</p>
      </aside>
    );
  const done = plan.steps.filter((step) => step.status === "completed").length;
  return (
    <aside className="card plan" aria-live="polite">
      <div className="plan__head">
        <h2 className="label">Plan</h2>
        <span className={`badge badge--${plan.status}`}>
          {done}/{plan.steps.length} · {plan.status}
        </span>
      </div>
      <p className="plan__goal">{plan.goal}</p>
      <ol className="plan__steps">
        {plan.steps.map((step) => {
          const Icon = STATUS_ICON[step.status];
          return (
            <li key={step.id} className={`step step--${step.status}`}>
              <Icon size={16} aria-hidden className="step__icon" />
              <div>
                <span className="step__title">{step.title}</span>
                {step.note && <span className="step__note">{step.note}</span>}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
