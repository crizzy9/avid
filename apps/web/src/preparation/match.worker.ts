import { generateAlignment } from "../../../../packages/playback/src/generated-alignment";
import type { AlignmentMatchInput } from "./match";

self.onmessage = ({ data }: MessageEvent<AlignmentMatchInput>) => {
  try {
    const snapshot = generateAlignment(data);
    self.postMessage({ type: "result", snapshot });
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
