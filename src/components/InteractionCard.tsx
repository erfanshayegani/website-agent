import { MessageCircleQuestion, Send } from "lucide-react";
import { useState } from "react";
import type { UserInteraction } from "../types";

export default function InteractionCard({
  interaction,
  onSubmit,
}: {
  interaction: UserInteraction;
  onSubmit(answer: string): void;
}) {
  const [custom, setCustom] = useState("");
  const showText = interaction.responseType === "text" || interaction.allowCustom;
  return (
    <section className="card interaction" aria-live="assertive">
      <p className="interaction__question">
        <MessageCircleQuestion size={18} aria-hidden /> {interaction.question}
      </p>
      {interaction.responseType === "select" && (
        <div className="interaction__options">
          {interaction.options.map((option) => (
            <button key={option} type="button" className="button" onClick={() => onSubmit(option)}>
              {option}
            </button>
          ))}
        </div>
      )}
      {showText && (
        <form
          className="interaction__form"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(custom);
          }}
        >
          <input
            value={custom}
            onChange={(event) => setCustom(event.target.value)}
            placeholder={interaction.placeholder ?? (interaction.responseType === "select" ? "Or write your own…" : "Your answer…")}
            autoFocus
          />
          <button type="submit" className="button button--primary" disabled={!custom.trim()}>
            <Send size={14} aria-hidden /> Reply
          </button>
        </form>
      )}
    </section>
  );
}
