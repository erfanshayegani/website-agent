import { ArrowLeft, Moon, Sun } from "lucide-react";
import { useState } from "react";

const SITE_URL = "https://erfanshayegani.github.io/";

function currentTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

export default function Header() {
  const [theme, setTheme] = useState(currentTheme);
  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("theme", next); // shared with the main site
    } catch {
      /* storage unavailable */
    }
    setTheme(next);
  };

  return (
    <header className="topbar">
      <a className="topbar__back" href={SITE_URL}>
        <ArrowLeft size={15} aria-hidden /> Erfan Shayegani
      </a>
      <div className="topbar__brand">
        <span className="orb" aria-hidden>
          <span className="orb__core" />
          <span className="orb__ring" />
        </span>
        <h1 className="topbar__title">
          Erfan Shayegani's 😈 <span className="gradient-text">Agent</span>
        </h1>
      </div>
      <button
        type="button"
        className="icon-button"
        onClick={toggle}
        aria-label="Toggle dark mode"
        title="Toggle dark mode"
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
