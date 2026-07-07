# Screen Recorder

Record your screen with system audio or mic — no watermark, no time limit,
nothing uploaded. This is the core logic of the
[Screen Recorder tool on subnsub.com](https://subnsub.com).

## Files

- [`recorder.js`](recorder.js) — the module: `ScreenRecorder`
- [`demo.html`](demo.html) — minimal standalone page

## Usage

```js
import { ScreenRecorder } from './recorder.js';

if (!ScreenRecorder.isSupported()) { /* phones don't expose capture — say so */ }

const rec = new ScreenRecorder({ systemAudio: true, microphone: false });
rec.onwarning  = (code) => {};   // 'mic-unavailable' | 'no-system-audio'
rec.onprogress = ({ state, bytes, durationMs }) => {};

await rec.start();               // rejects: 'cancelled' | 'start-failed'
rec.pause(); rec.resume(); rec.stop();

const { blob, mimeType, durationMs } = await rec.finished;
// rejects 'recording-failed' when the recorder errored or produced 0 bytes
```

## Design notes

- **Container**: mp4 when the browser can mux it (`isTypeSupported` probe,
  Safari/Chrome), webm otherwise — probed, never assumed.
- **Audio**: system audio rides the display stream when the picker granted
  it. With the microphone on too, both mix through an `AudioContext`
  destination so they coexist in one track.
- **One stop path.** The Stop button, the browser's own "stop sharing"
  pill (video track `ended`) and a recorder error all funnel into the same
  idempotent stop → finalize sequence — a `stopping` flag makes the three
  arrivals finalize exactly once, and a `failed` flag makes an errored
  recording report failure instead of celebrating an empty file.
- **No hidden captures.** `abort()` voids an in-flight permission chain
  (the tracks it obtains afterwards are stopped immediately) — the site
  calls it whenever the hosting UI is hidden, so a live capture can never
  keep running headless.
