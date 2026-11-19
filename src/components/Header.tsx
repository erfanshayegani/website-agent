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
    <header className="header">
      <a className="header__back" href={SITE_URL}>
        <ArrowLeft size={15} aria-hidden /> Erfan Shayegani
      </a>
      <button
        type="button"
        className="icon-button"
        onClick={toggle}
        aria-label="Toggle dark mode"
        title="Toggle dark mode"
      >
        {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
      <div className="header__title">
        <h1>LFM Agent 🧪</h1>
        <p>
          A research agent that runs entirely in your browser. It plans, searches Wikipedia, reads
          webpages and runs Python, using <strong>LFM2.5-2.6B</strong> on your own GPU via WebGPU.
          Nothing you type is sent to a model server.
        </p>
      </div>
    </header>
  );
}
