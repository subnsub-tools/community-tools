/* Screen Recorder — getDisplayMedia + MediaRecorder, all in-memory.
   Core logic of the Screen Recorder tool on subnsub.com, kept in lockstep
   with the in-page version.

   Chunks accumulate at a 1 s timeslice and finalize into one local file:
   mp4 when the browser can mux it (isTypeSupported probe), webm
   otherwise. System audio rides the display stream when the picker
   granted it; the microphone mixes in through an AudioContext destination
   so both can coexist. The browser's own "stop sharing" pill routes into
   the same stop path via the video track's onended. Phones don't expose
   capture — check isSupported() and say so instead of leaving a dead
   button.

   Usage:
     const rec = new ScreenRecorder({ systemAudio: true, microphone: false });
     rec.onwarning  = (code) => {};   // 'mic-unavailable' | 'no-system-audio'
     rec.onprogress = ({ state, bytes, durationMs }) => {};
     await rec.start();               // rejects: 'cancelled' | 'start-failed'
     rec.pause(); rec.resume();
     rec.stop();                      // or the browser's stop-sharing pill
     const { blob, mimeType, durationMs } = await rec.finished;
                                      // rejects 'recording-failed' when the
                                      // recorder errored or produced 0 bytes */

export class ScreenRecorder {
  constructor({ systemAudio = true, microphone = false, timeslice = 1000 } = {}) {
    this.systemAudio = systemAudio;
    this.microphone = microphone;
    this.timeslice = timeslice;
    this.state = 'idle';           /* idle | rec | paused | done */
    this.bytes = 0;
    this.onwarning = null;
    this.onprogress = null;
    this._disp = null;
    this._mic = null;
    this._rec = null;
    this._ac = null;
    this._chunks = [];
    this._acc = 0;
    this._t0 = 0;
    this._stopping = false;        /* stop click + pill 'ended' + onerror can all fire — finalize once */
    this._failed = false;          /* recorder errored: finalize must report, not celebrate */
    this._starting = false;        /* async permission chain in flight; abort() must void it */
    this.finished = new Promise((res, rej) => { this._resolve = res; this._reject = rej; });
  }

  static isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);
  }

  static pickMime() {
    const cands = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const c of cands) {
      try { if (window.MediaRecorder.isTypeSupported(c)) return c; } catch (_) {}
    }
    return '';
  }

  durationMs() {
    return this._acc + (this.state === 'rec' ? Date.now() - this._t0 : 0);
  }

  _warn(code) { try { if (this.onwarning) this.onwarning(code); } catch (_) {} }
  _emit() {
    try {
      if (this.onprogress) this.onprogress({ state: this.state, bytes: this.bytes, durationMs: this.durationMs() });
    } catch (_) {}
  }
  _stopTracks() {
    try { if (this._disp) this._disp.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { if (this._mic) this._mic.getTracks().forEach((t) => t.stop()); } catch (_) {}
    this._disp = null; this._mic = null;
    if (this._ac) { try { this._ac.close(); } catch (_) {} this._ac = null; }
  }

  _finalize() {
    const type = (this._rec && this._rec.mimeType) || 'video/webm';
    this._rec = null;
    this._stopping = false;
    this._stopTracks();
    const blob = new Blob(this._chunks, { type: type.split(';')[0] });
    this._chunks = [];
    this.state = 'done';
    if (this._failed || !blob.size) {
      const e = new Error('recording-failed'); e.code = 'recording-failed';
      this._reject(e);
      return;
    }
    this._resolve({ blob, mimeType: type.split(';')[0], durationMs: this._acc });
  }

  async start() {
    if (this.state !== 'idle' || this._starting) return;
    this._starting = true;
    let d;
    try {
      d = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: this.systemAudio });
    } catch (err) {
      this._starting = false;
      const cancel = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      const e = new Error(cancel ? 'cancelled' : 'start-failed'); e.code = e.message;
      throw e;
    }
    if (!this._starting) {          /* abort()ed mid-permission — do not start a hidden recording */
      try { d.getTracks().forEach((t) => t.stop()); } catch (_) {}
      const e = new Error('cancelled'); e.code = 'cancelled';
      throw e;
    }
    this._disp = d;
    let m = null;
    if (this.microphone) {
      m = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        this._warn('mic-unavailable');
        return null;
      });
    }
    if (!this._starting) {
      if (m) { try { m.getTracks().forEach((t) => t.stop()); } catch (_) {} }
      const e = new Error('cancelled'); e.code = 'cancelled';
      throw e;
    }
    this._mic = m;
    /* From here on we hold LIVE tracks — any construction failure
       (AudioContext, mixing, an unsupported MediaRecorder config) must
       stop them, or the capture keeps running with no way to reach it. */
    try {
      const vTracks = d.getVideoTracks();
      const dispA = d.getAudioTracks();
      let tracks = vTracks.slice();
      if (m) {
        this._ac = new (window.AudioContext || window.webkitAudioContext)();
        const dest = this._ac.createMediaStreamDestination();
        if (dispA.length) this._ac.createMediaStreamSource(new MediaStream(dispA)).connect(dest);
        this._ac.createMediaStreamSource(new MediaStream(m.getAudioTracks())).connect(dest);
        tracks = tracks.concat(dest.stream.getAudioTracks());
      } else if (dispA.length) {
        tracks = tracks.concat(dispA);
      } else if (this.systemAudio) {
        this._warn('no-system-audio');
      }
      const mime = ScreenRecorder.pickMime();
      this._rec = new MediaRecorder(new MediaStream(tracks), mime ? { mimeType: mime } : undefined);
      this._chunks = []; this.bytes = 0; this._acc = 0;
      this._stopping = false; this._failed = false;
      this._rec.ondataavailable = (e) => {
        if (e.data && e.data.size) { this._chunks.push(e.data); this.bytes += e.data.size; this._emit(); }
      };
      this._rec.onstop = () => this._finalize();
      this._rec.onerror = () => { this._failed = true; this.stop(); };
      /* the browser's own "stop sharing" pill must land in the same path */
      if (vTracks[0]) vTracks[0].addEventListener('ended', () => this.stop());
      this._rec.start(this.timeslice);
    } catch (_) {
      this._starting = false;
      this._rec = null;
      this._stopTracks();
      const e = new Error('start-failed'); e.code = 'start-failed';
      throw e;
    }
    this._starting = false;
    this.state = 'rec';
    this._t0 = Date.now();
    this._emit();
  }

  pause() {
    if (this.state !== 'rec' || !this._rec) return;
    try { this._rec.pause(); } catch (_) { return; }
    this._acc += Date.now() - this._t0;
    this.state = 'paused';
    this._emit();
  }

  resume() {
    if (this.state !== 'paused' || !this._rec) return;
    try { this._rec.resume(); } catch (_) { return; }
    this._t0 = Date.now();
    this.state = 'rec';
    this._emit();
  }

  stop() {
    if (this.state !== 'rec' && this.state !== 'paused') return;
    if (this._stopping) return;     /* Stop click + pill 'ended' + onerror may all arrive */
    this._stopping = true;
    if (this.state === 'rec') this._acc += Date.now() - this._t0;
    this.state = 'paused';          /* freeze the clock while finalize flushes */
    try { this._rec.stop(); }       /* onstop → _finalize() */
    catch (_) { this._finalize(); }
  }

  /* Hard access-loss path (the site calls this when the hosting UI is
     hidden): void an in-flight permission chain, or stop and keep the
     footage. Never leaves a live capture running headless. */
  abort() {
    if (this._starting) {
      this._starting = false;
      this._stopTracks();
      return;
    }
    this.stop();
  }
}
