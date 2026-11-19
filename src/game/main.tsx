import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GameApp from "./GameApp";
import "../styles/tokens.css";
import "../styles/app.css";
import "./game.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GameApp />
  </StrictMode>
);
