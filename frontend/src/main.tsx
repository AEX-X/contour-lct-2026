import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { ContourProvider } from "./app/ContourProvider";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { PwaUpdatePrompt } from "./components/PwaUpdatePrompt";
import "./styles/index.css";
import "./app/app.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element is missing");
}

createRoot(rootElement).render(
  <StrictMode>
    <BrowserRouter>
      <AppErrorBoundary>
        <ContourProvider>
          <App />
        </ContourProvider>
        <PwaUpdatePrompt />
      </AppErrorBoundary>
    </BrowserRouter>
  </StrictMode>,
);
