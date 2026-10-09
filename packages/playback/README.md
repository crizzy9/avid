# Avid playback

The browser transport owns one `HTMLAudioElement`. React subscribes to immutable snapshots. Source seconds always refer to the original recording, including at non-default playback rates.

```tsx
import { useSyncExternalStore } from 'react';
import { PlaybackController } from '../../../packages/playback/src';

// Create once for the app lifetime; destroy on app shutdown/account owner replacement.
const playback = new PlaybackController({ preferredRate: 1 });

function Player() {
  const state = useSyncExternalStore(playback.subscribe, playback.getSnapshot);
  return <button onClick={() => void playback.toggle()}>{state.status === 'playing' ? 'Pause' : 'Play'}</button>;
}

playback.load({
  bookId: 'server-book-id', fileId: 'server-file-id', title: 'A title', authors: ['Author'],
  tracks: [{ id: 'server-file-id', url: '/authorized/audio.mp3', duration: 600 }],
  chapters: [{ id: 'chapter-1', title: 'One', start: 0, duration: 600 }],
}, 42);
```

`play`, `pause`, `toggle`, `seek`, `skip`, `goToChapter`, `setRate`, and `setSleepTimer` control the transport. `setSleepTimer({minutes: 20})`, `setSleepTimer({endOfChapter: true})`, and `setSleepTimer(null)` set or cancel sleep. `getBook()` supplies normalized chapters. Rate is clamped to 0.5–3.0; persist the preferred rate in the account's preferences outside this controller.

`onCheckpoint(callback)` emits a ReadingAnchor-compatible record on seeks, pauses, track completion, teardown, and approximately every five seconds of playback updates. Call `checkpoint()` on pagehide. The callback's `locator` is JSON `{version:1, trackId, trackTime, time}`. `trackTime` is seconds within that exact server file/track; `time` is book-timeline seconds. Never replace that anchor with the displayed percentage. The application must write the checkpoint to its account-scoped journal before syncing it. An optional synchronous `persistCheckpoint` callback precedes checkpoint subscribers.

Durations are required for every track except the final one, whose metadata can supply its duration. If the total is incomplete, `duration` is zero until it is known; this avoids pretending that a partial sum is the entire book. Chapter arrays must be ordered, positive-duration, and non-overlapping. Browser codecs are preflighted through `getAudioCodecSupport` / `resolveAudioSource`; actual decode and server range support still need file fixtures.

The transport exposes `stopped`, `loading`, `playing`, `paused`, `buffering`, `interrupted`, and `failed` states. Failures are in `snapshot.error`. Media Session handlers are registered only where the browser supports them and removed on teardown. No authorization headers are invented for media URLs: the integration must supply a verified accessible URL or owned blob URL and revoke it only after the audio owner releases it.

`SpeechController` lists installed voices and exposes `speak`, `pause`, `resume`, `cancel`, and `onVoicesChanged`. `speak({text, start, voiceURI, rate, onBoundary, onEnd})` reports real engine boundary events as UTF-16 offsets into `text`. Use `onEnd` to obtain the next reader passage, and `onBoundary` to reveal/highlight its reader range. An engine that emits no boundary callbacks gets no fabricated timed highlighting. Cancel speech before starting an audiobook and pause the audiobook before starting speech.

For already aligned material, validate the map with `validateAlignment`, then use `textAtAudioTime` and `audioAtTextLocator`. Segment boundaries are half-open; unaligned gaps return `null`. `canBridgeAudio` applies only the duration sanity rule; it does not establish edition compatibility or generate alignment.

Browser sleep timers and speech follow the browser lifecycle. Suspended or killed WebViews do not satisfy native background guarantees. Native source and release gates are documented in `docs/platforms.md`.
