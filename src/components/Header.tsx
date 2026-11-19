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
      <div className="topbar__left">
        <a className="topbar__back" href={SITE_URL}>
          <ArrowLeft size={15} aria-hidden /> Erfan Shayegani 😈
        </a>
        <button
          type="button"
          className="icon-button theme-toggle"
          onClick={toggle}
          aria-label="Toggle dark mode"
          title="Toggle dark mode"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </div>
      <div className="topbar__brand">
        <span className="orb" aria-hidden>
          <span className="orb__core" />
          <span className="orb__ring" />
        </span>
        <h1 className="topbar__title">
          <a className="topbar__owner" href={SITE_URL}>
            Erfan Shayegani
          </a>
          's 😈 <span className="gradient-text">Agent</span>
        </h1>
      </div>
      <span aria-hidden />
    </header>
  );
}
