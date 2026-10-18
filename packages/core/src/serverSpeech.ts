import { z } from "zod";
/** Only public provider metadata; credentials remain configured on BookOrbit. */
export const serverSpeechProviderSchema = z.object({
  id: z.string().min(1).max(255),
  name: z.string().max(500),
  type: z.literal("openai-compatible"),
});
export type ServerSpeechProvider = z.infer<typeof serverSpeechProviderSchema>;
export const serverSpeechVoiceSchema = z.object({
  id: z.string().min(1).max(500),
  name: z.string().max(500),
  shortName: z.string().max(500),
  language: z.string().max(100),
  locale: z.string().max(100),
  gender: z.string().max(100),
  providerId: z.string().min(1).max(255),
  providerName: z.string().max(500),
});
export type ServerSpeechVoice = z.infer<typeof serverSpeechVoiceSchema>;
export const serverSpeechRequestSchema = z
  .object({
    text: z
      .string()
      .min(1)
      .max(5000)
      .refine((value) => value.trim().length > 0, "Speech text is empty."),
    voiceId: z.string().min(1).max(500),
    providerId: z.string().min(1).max(255),
    speed: z.number().finite().min(0.25).max(4),
    format: z.literal("mp3").default("mp3"),
  })
  .strict();
export type ServerSpeechRequest = z.input<typeof serverSpeechRequestSchema>;
export const serverSpeechCaptionSchema = z.object({
  audio: z
    .string()
    .min(1)
    .max(24 * 1024 ** 2),
  format: z.literal("mp3"),
  words: z
    .array(
      z.object({
        word: z.string().max(5000),
        startTime: z.number().finite().nonnegative(),
        endTime: z.number().finite().nonnegative(),
      }),
    )
    .max(20000),
});
export interface ServerSpeechAudio {
  audio: Blob;
  words: { word: string; startTime: number; endTime: number }[];
}
export interface ServerSpeechCapabilities {
  available: boolean;
  providers: ServerSpeechProvider[];
  voices: ServerSpeechVoice[];
  reason?: "unsupported" | "forbidden" | "unconfigured";
}
export function decodeServerSpeech(value: unknown): ServerSpeechAudio {
  const { audio, words } = serverSpeechCaptionSchema.parse(value);
  if (audio.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(audio))
    throw new Error("The voice service returned invalid audio.");
  const bytes = Uint8Array.from(atob(audio), (character) =>
    character.charCodeAt(0),
  );
  if (!bytes.length || bytes.length > 16 * 1024 ** 2)
    throw new Error("The voice audio exceeds the supported limit.");
  let previous = -1;
  for (const word of words) {
    if (word.endTime <= word.startTime || word.startTime < previous)
      throw new Error("The voice service returned invalid word timings.");
    previous = word.startTime;
  }
  return { audio: new Blob([bytes], { type: "audio/mpeg" }), words };
}
