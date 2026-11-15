import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Root, applyPlatform } from "./Root";
import "./styles/index.css";

applyPlatform(document, window.silico?.platform);

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <StrictMode>
      <Root hash={window.location.hash} />
    </StrictMode>,
  );
}
