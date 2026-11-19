import { ArrowLeft, Lock, Moon, RotateCcw, Send, Square, Sun } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import AgentMascot, { type MascotState } from "../components/AgentMascot";
import Markdown from "../components/Markdown";
import ModelCard from "../components/ModelCard";
import { LEVELS, TURNS_PER_LEVEL } from "./levels";
import { useGame, type GameMessage } from "./useGame";

const SITE_URL = "https://erfanshayegani.github.io/";

function ThemeToggle() {
  const [theme, setTheme] = useState(() =>
    document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light"
  );
  return (
    <button
      type="button"
      className="icon-button theme-toggle"
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        try {
          localStorage.setItem("theme", next);
        } catch {
          /* storage unavailable */
        }
        setTheme(next);
      }}
    >
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

function Bubble({ message, reveal }: { message: GameMessage; reveal: boolean }) {
  if (message.role === "user")
    return (
      <div className="bubble bubble--user">
        <p>{message.content}</p>
      </div>
    );
  const blocked = message.status === "filtered" || message.status === "guarded";
  return (
    <div className={`bubble bubble--bot ${blocked ? "bubble--blocked" : ""}`}>
      {message.status === "streaming" && !message.content ? (
        <p className="bubble__live">
          <span className="bubble__pulse" aria-hidden /> 🧠 thinking…
          <span className="bubble__count">{(message.tokens ?? 0).toLocaleString()} tokens</span>
        </p>
      ) : blocked && !reveal ? (
        <p className="bubble__blocked">
          {message.status === "filtered"
            ? "🧱 The filter blocked this reply (it contained the secret word)."
            : "🛡️ The guard blocked this reply (it judged it a leak)."}
        </p>
      ) : (
        <>
          {blocked && (
            <p className="bubble__tag">
              {message.status === "filtered" ? "🧱 blocked by the filter" : "🛡️ blocked by the guard"}
            </p>
          )}
          <Markdown>{message.content}</Markdown>
        </>
      )}
      {message.leakHow && <p className="bubble__leak">🎯 Leaked ({message.leakHow})!</p>}
      {message.status === "streaming" && message.content ? (
        <p className="bubble__meta">
          <span className="bubble__pulse" aria-hidden /> writing… {(message.tokens ?? 0).toLocaleString()} tokens
        </p>
      ) : message.status !== "streaming" && message.tokens ? (
        <p className="bubble__meta">{message.tokens.toLocaleString()} tokens</p>
      ) : null}
      {reveal && message.thinking && (
        <details className="bubble__thinking">
          <summary>What it was thinking</summary>
          <p>{message.thinking}</p>
        </details>
      )}
    </div>
  );
}

export default function GameApp() {
  const game = useGame();
  const [input, setInput] = useState("");
  const chatLog = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const ready = game.modelPhase === "ready";
  const over = game.outcome !== "playing";
  const turnsLeft = TURNS_PER_LEVEL - game.turnsUsed;

  // Keep the chat box (never the page) scrolled to the newest text, but only
  // while the reader is already at the bottom of it.
  useEffect(() => {
    const log = chatLog.current;
    if (log && stickToBottom.current) log.scrollTop = log.scrollHeight;
  }, [game.messages]);

  const mood: MascotState =
    game.outcome === "won"
      ? "shocked"
      : game.outcome === "lost"
        ? "smug"
        : game.busy !== "idle"
          ? "working"
          : "awake";

  const submit = () => {
    if (!input.trim()) return;
    stickToBottom.current = true; // follow your own new message
    void game.sendMessage(input);
    setInput("");
  };

  return (
    <div className="app game">
      <div className="backdrop" aria-hidden />
      <header className="topbar">
        <div className="topbar__left">
          <a className="topbar__back" href={SITE_URL}>
            <ArrowLeft size={15} aria-hidden /> Erfan Shayegani 😈
          </a>
          <ThemeToggle />
        </div>
        <h1 className="topbar__title">
          Keep the <span className="gradient-text">Secret</span> 🤫
        </h1>
        <span aria-hidden />
      </header>

      <main className="game__main">
        {!ready ? (
          <ModelCard
            phase={game.modelPhase}
            runPhase="idle"
            progress={game.progress}
            onLoad={game.load}
          />
        ) : (
          <section className="card game__hero">
            <AgentMascot state={mood} size={76} />
            <div>
              <h2 className="game__pitch">
                Erfan told his agent a secret word. You have {TURNS_PER_LEVEL} messages to make it
                slip.
              </h2>
              <p className="muted small">
                Hint: it's {game.secret.hint}. Only the agent's visible answer counts.
              </p>
            </div>
          </section>
        )}

        <section className="card levels" aria-label="Levels">
          {LEVELS.map((level, index) => {
            const locked = level.id > game.unlocked;
            return (
              <button
                key={level.id}
                type="button"
                className={`level ${index === game.levelIndex ? "level--active" : ""}`}
                disabled={locked || game.busy !== "idle"}
                onClick={() => game.newGame(index)}
                title={locked ? "Beat the previous level to unlock" : level.tagline}
              >
                <span className="level__emoji" aria-hidden>
                  {locked ? <Lock size={16} /> : level.emoji}
                </span>
                <span className="level__name">
                  {level.id}. {level.name}
                </span>
              </button>
            );
          })}
          <p className="levels__tagline muted small">
            <strong>{game.level.emoji} {game.level.name}:</strong> {game.level.tagline}
          </p>
          {game.level.inspiration && (
            <details className="inspire">
              <summary>💡 Need inspiration?</summary>
              <p className="inspire__title">{game.level.inspiration.title}</p>
              <ol className="inspire__list">
                {game.level.inspiration.messages.map((message, index) => (
                  <li key={index}>
                    {game.level.inspiration!.messages.length > 1 && (
                      <span className="inspire__round">Round {index + 1}</span>
                    )}
                    <code className="inspire__code">{message}</code>
                    <button
                      type="button"
                      className="button button--small"
                      disabled={!ready || game.busy !== "idle" || over}
                      onClick={() => setInput(message)}
                    >
                      Use this
                    </button>
                  </li>
                ))}
              </ol>
              <p className="muted small inspire__note">
                These have worked before, but might not always work due to the probabilistic nature of
                LLMs. They're here for inspiration. 😈
              </p>
            </details>
          )}
        </section>

        <section className="card chat">
          <div className="chat__head">
            <span className="label">Your messages</span>
            <span className="turns" aria-label={`${turnsLeft} messages left`}>
              {Array.from({ length: TURNS_PER_LEVEL }, (_, index) => (
                <span key={index} className={`turns__dot ${index < turnsLeft ? "turns__dot--left" : ""}`} />
              ))}
              <span className="muted small">{turnsLeft} left</span>
            </span>
          </div>

          <div
            className="chat__log"
            aria-live="polite"
            ref={chatLog}
            // Any upward scroll intent releases auto-follow immediately (trackpads
            // scroll in tiny steps); reaching the very bottom again re-enables it.
            onWheel={(event) => {
              if (event.deltaY < 0) stickToBottom.current = false;
            }}
            onTouchMove={() => {
              stickToBottom.current = false;
            }}
            onKeyDown={(event) => {
              if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stickToBottom.current = false;
            }}
            onScroll={(event) => {
              const log = event.currentTarget;
              if (log.scrollHeight - log.scrollTop - log.clientHeight < 4) stickToBottom.current = true;
            }}
          >
            {game.messages.length === 0 && (
              <p className="chat__empty muted">
                {ready
                  ? "Say hi, ask nicely, role-play, trick it… whatever works. 😈"
                  : "Wake up the agent first, then start chatting."}
              </p>
            )}
            {game.messages.map((message) => (
              <Bubble key={message.id} message={message} reveal={over} />
            ))}
            {game.busy === "guarding" && (
              <p className="muted small chat__status">
                <span className="bubble__pulse" aria-hidden /> 🛡️ The guard is reviewing the reply…{" "}
                {game.guardTokens.toLocaleString()} tokens
              </p>
            )}
          </div>

          {over ? (
            <div className={`result result--${game.outcome}`}>
              {game.outcome === "won" ? (
                <p>
                  🎉 <strong>It leaked!</strong> The secret was <code>{game.secret.word}</code>.
                  {game.level.id < LEVELS.length ? " Next level unlocked." : " You beat every level!"}
                </p>
              ) : (
                <p>
                  😏 <strong>It kept the secret.</strong> It was <code>{game.secret.word}</code>. Want to try
                  again?
                </p>
              )}
              <div className="result__actions">
                <button type="button" className="button" onClick={() => game.newGame()}>
                  <RotateCcw size={14} aria-hidden /> Play again
                </button>
                {game.outcome === "won" && game.level.id < LEVELS.length && (
                  <button type="button" className="button button--glow" onClick={() => game.newGame(game.levelIndex + 1)}>
                    Next level →
                  </button>
                )}
              </div>
            </div>
          ) : (
            <form
              className="chat__form"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              <textarea
                className="chat__input"
                rows={2}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  // Enter sends; Shift+Enter adds a new line.
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    submit();
                  }
                }}
                placeholder={ready ? "Try to get the secret… (Shift+Enter for a new line)" : "Wake up the agent first"}
                disabled={!ready || game.busy !== "idle"}
                aria-label="Your message"
              />
              {game.busy !== "idle" ? (
                <button type="button" className="button button--danger" onClick={game.stop}>
                  <Square size={14} aria-hidden /> Stop
                </button>
              ) : (
                <button type="submit" className="button button--glow" disabled={!ready || !input.trim()}>
                  <Send size={14} aria-hidden /> Send
                </button>
              )}
            </form>
          )}
          {game.error && <p className="notice notice--danger small">{game.error}</p>}
        </section>

        <p className="game__fineprint muted small">
          Runs entirely in your browser with LFM2.5-2.6B, so a determined player could find the secret in
          the developer tools. That's cheating though. 😉 A new secret is picked every game.
        </p>
      </main>
    </div>
  );
}
