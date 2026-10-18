/** Pinned models with genuine word timestamp support. No publication text is sent to a server. */
export const SPEECH_MODELS = Object.freeze({
  balanced: Object.freeze({
    id: "Xenova/whisper-base.en",
    revision: "95bf40a508535962c6483ead40270b2e32267508",
  }),
  compact: Object.freeze({
    id: "Xenova/whisper-tiny.en",
    revision: "79fb389fc764e7c395bd330e9531d9d32ada7049",
  }),
});
export type SpeechProfile = keyof typeof SPEECH_MODELS;
export const DEFAULT_SPEECH_PROFILE: SpeechProfile = "balanced";
export const SPEECH_MODEL = SPEECH_MODELS[DEFAULT_SPEECH_PROFILE];
export function speechModel(profile: SpeechProfile = DEFAULT_SPEECH_PROFILE) {
  const model = SPEECH_MODELS[profile];
  if (!model) throw new Error("Unknown local speech model.");
  return model;
}
