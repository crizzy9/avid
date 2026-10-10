import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import {
  getNativeSpeech,
  nativeSpeechProvider,
} from "../../mobile/src/native-speech";
import { registerSpeechProvider } from "../../../packages/playback/src/speechRuntime";
import { getDesktopSpeech } from "../../desktop/src/bridge";
import "./styles.css";

const nativeSpeech = getNativeSpeech() ?? getDesktopSpeech();
if (nativeSpeech) registerSpeechProvider(nativeSpeechProvider(nativeSpeech));

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
