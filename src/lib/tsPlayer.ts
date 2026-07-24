import muxjs from 'mux.js';

// Plays MPEG-TS files through MediaSource by transmuxing to fragmented MP4
// with mux.js. Browsers cannot play .ts containers natively. Seeking is
// approximate: MPEG-TS has no index, so seek targets are mapped to byte
// offsets proportionally (time / duration * size) and re-synced on the next
// 188-byte packet boundary.

interface MegaFileLike {
  size: number;
  name: string;
  download(opts: { start: number; end: number; maxConnections?: number }): any;
}

const TS_PACKET = 188;
const PROBE_SIZE = 1536 * 1024;
const CHUNK_SIZE = 3 * 1024 * 1024;
const AHEAD_TARGET_SECS = 30;
const PTS_CLOCK = 90000;
const PTS_WRAP = 2 ** 33;

export function isTransportStream(name: string): boolean {
  return name.toLowerCase().endsWith('.ts');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readRange(
  node: MegaFileLike,
  start: number,
  end: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let stream: any;
    try {
      stream = node.download({ start, end, maxConnections: 4 });
    } catch (err) {
      reject(err);
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const onAbort = () => {
      try {
        stream.destroy?.();
      } catch (_) {}
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (c: Uint8Array) => {
      const view = c instanceof Uint8Array ? c : new Uint8Array(c as any);
      const copy = new Uint8Array(view.byteLength);
      copy.set(view);
      chunks.push(copy);
      total += copy.byteLength;
    });
    stream.on('end', () => {
      signal.removeEventListener('abort', onAbort);
      const out = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.byteLength;
      }
      resolve(out);
    });
    stream.on('error', (err: Error) => {
      signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

function syncOffset(buf: Uint8Array): number {
  const limit = Math.min(buf.length - TS_PACKET * 2 - 1, TS_PACKET);
  for (let s = 0; s <= limit; s++) {
    if (buf[s] === 0x47 && buf[s + TS_PACKET] === 0x47 && buf[s + TS_PACKET * 2] === 0x47) {
      return s;
    }
  }
  return -1;
}

// Reads the PTS of a PES packet starting at TS packet offset i, if present.
function readPts(buf: Uint8Array, i: number): number | null {
  if ((buf[i + 1] & 0x40) === 0) return null; // not a payload start
  const afc = (buf[i + 3] >> 4) & 0x3;
  if ((afc & 0x1) === 0) return null; // no payload
  let p = i + 4;
  if (afc & 0x2) p += 1 + buf[i + 4];
  if (p + 14 > i + TS_PACKET) return null;
  if (buf[p] !== 0 || buf[p + 1] !== 0 || buf[p + 2] !== 1) return null;
  const streamId = buf[p + 3];
  const isMedia = streamId >= 0xc0 && streamId <= 0xef; // audio or video PES
  if (!isMedia) return null;
  if ((buf[p + 7] & 0x80) === 0) return null; // no PTS
  const b = buf.subarray(p + 9, p + 14);
  // 33-bit value — use multiplication to avoid 32-bit bitwise overflow
  return (
    ((b[0] >> 1) & 0x07) * 0x40000000 +
    b[1] * 0x400000 +
    ((b[2] >> 1) & 0x7f) * 0x8000 +
    b[3] * 0x80 +
    (b[4] >> 1)
  );
}

function scanPts(buf: Uint8Array, wantLast: boolean): number | null {
  const start = syncOffset(buf);
  if (start < 0) return null;
  let result: number | null = null;
  for (let i = start; i + TS_PACKET <= buf.length; i += TS_PACKET) {
    if (buf[i] !== 0x47) {
      // lost sync — resync
      const rest = buf.subarray(i);
      const s = syncOffset(rest);
      if (s < 0) break;
      i += s - TS_PACKET;
      continue;
    }
    const pts = readPts(buf, i);
    if (pts != null) {
      if (!wantLast) return pts;
      result = pts;
    }
  }
  return result;
}

// Feeding arbitrary byte-aligned chunks to the transmuxer corrupts the frame
// at every flush boundary: flush() forces the in-progress PES packet out
// truncated, and the decoder dies on that sample (PIPELINE_ERROR_DECODE).
// This reframer withholds, per elementary PID, all packets from the last PES
// start onward so every flushed window contains only complete PES packets.
// Withheld packets are prepended to the next chunk. Reordering packets across
// PIDs is safe because mux.js assembles PES per PID and buffers everything
// until flush anyway.
class TsReframer {
  private carry: Uint8Array | null = null; // partial trailing TS packet
  private holdback: Uint8Array | null = null; // whole packets of open PES
  private pesPids = new Set<number>();

  process(chunk: Uint8Array, atEof: boolean): Uint8Array {
    let buf: Uint8Array;
    if (this.holdback || this.carry) {
      const h = this.holdback ?? new Uint8Array(0);
      const c = this.carry ?? new Uint8Array(0);
      buf = new Uint8Array(h.length + c.length + chunk.length);
      buf.set(h, 0);
      buf.set(c, h.length);
      buf.set(chunk, h.length + c.length);
      this.holdback = null;
      this.carry = null;
    } else {
      buf = chunk;
    }

    let start = 0;
    if (buf.length >= TS_PACKET && buf[0] !== 0x47) {
      const s = syncOffset(buf);
      if (s < 0) return new Uint8Array(0);
      start = s;
    }
    const packetCount = Math.floor((buf.length - start) / TS_PACKET);
    const tail = start + packetCount * TS_PACKET;
    if (tail < buf.length) this.carry = buf.slice(tail);

    if (atEof) {
      return buf.subarray(start, tail);
    }

    // find, per PES pid, the packet index of its last PES start in this window
    const lastPusi = new Map<number, number>();
    for (let p = 0; p < packetCount; p++) {
      const i = start + p * TS_PACKET;
      if (buf[i] !== 0x47) continue;
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
      if ((buf[i + 1] & 0x40) === 0) continue; // not a payload start
      const afc = (buf[i + 3] >> 4) & 0x3;
      if ((afc & 0x1) === 0) continue;
      let off = i + 4;
      if (afc & 0x2) off += 1 + buf[i + 4];
      if (off + 3 <= i + TS_PACKET && buf[off] === 0 && buf[off + 1] === 0 && buf[off + 2] === 1) {
        this.pesPids.add(pid);
        lastPusi.set(pid, p);
      }
    }

    const held: boolean[] = new Array(packetCount).fill(false);
    for (let p = 0; p < packetCount; p++) {
      const i = start + p * TS_PACKET;
      if (buf[i] !== 0x47) continue;
      const pid = ((buf[i + 1] & 0x1f) << 8) | buf[i + 2];
      if (!this.pesPids.has(pid)) continue;
      const last = lastPusi.get(pid);
      // Packets from the last PES start onward belong to a PES that will only
      // be completed by future data. Leading packets of a PID with no PES
      // start in this window are stragglers mux.js discards — let them pass.
      if (last !== undefined && p >= last) held[p] = true;
    }

    let heldCount = 0;
    for (let p = 0; p < packetCount; p++) if (held[p]) heldCount++;
    const out = new Uint8Array((packetCount - heldCount) * TS_PACKET);
    const hold = new Uint8Array(heldCount * TS_PACKET);
    let oOff = 0;
    let hOff = 0;
    for (let p = 0; p < packetCount; p++) {
      const i = start + p * TS_PACKET;
      const pkt = buf.subarray(i, i + TS_PACKET);
      if (held[p]) {
        hold.set(pkt, hOff);
        hOff += TS_PACKET;
      } else {
        out.set(pkt, oOff);
        oOff += TS_PACKET;
      }
    }
    if (heldCount > 0) this.holdback = hold;
    return out;
  }
}

function transmuxProbe(data: Uint8Array): Uint8Array {
  const t = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
  let init: Uint8Array | null = null;
  t.on('data', (seg) => {
    if (!init) init = new Uint8Array(seg.initSegment);
  });
  t.push(data);
  t.flush();
  t.dispose();
  if (!init) throw new Error('Could not transmux MPEG-TS — unsupported codecs?');
  return init;
}

function indexOfAscii(buf: Uint8Array, str: string): number {
  outer: for (let i = 0; i <= buf.length - str.length; i++) {
    for (let j = 0; j < str.length; j++) {
      if (buf[i + j] !== str.charCodeAt(j)) continue outer;
    }
    return i;
  }
  return -1;
}

function mimeFromInit(init: Uint8Array): string {
  const codecs: string[] = [];
  const avcc = indexOfAscii(init, 'avcC');
  if (avcc >= 0) {
    const hex = (n: number) => n.toString(16).toUpperCase().padStart(2, '0');
    codecs.push(`avc1.${hex(init[avcc + 5])}${hex(init[avcc + 6])}${hex(init[avcc + 7])}`);
  }
  if (indexOfAscii(init, 'mp4a') >= 0) codecs.push('mp4a.40.2');
  if (codecs.length === 0) throw new Error('No playable tracks in MPEG-TS');
  return `${avcc >= 0 ? 'video' : 'audio'}/mp4; codecs="${codecs.join(',')}"`;
}

export interface TsPlayerHandle {
  duration: number;
  destroy(): void;
}

export async function attachTsPlayer(
  video: HTMLVideoElement,
  node: MegaFileLike
): Promise<TsPlayerHandle> {
  const size = node.size;
  if (typeof size !== 'number' || size < TS_PACKET * 8) {
    throw new Error('File size unknown or too small');
  }

  let aborter = new AbortController();

  const head = await readRange(node, 0, Math.min(PROBE_SIZE, size) - 1, aborter.signal);
  const tailStart = Math.max(0, size - PROBE_SIZE);
  const tail =
    tailStart === 0 ? head : await readRange(node, tailStart, size - 1, aborter.signal);

  const firstPts = scanPts(head, false);
  const lastPts = scanPts(tail, true);
  if (firstPts == null || lastPts == null) {
    throw new Error('No MPEG-TS timestamps found — not a transport stream?');
  }
  const basePts = firstPts;
  let ptsSpan = lastPts - basePts;
  if (ptsSpan < 0) ptsSpan += PTS_WRAP;
  const duration = ptsSpan / PTS_CLOCK;
  if (!(duration > 0)) throw new Error('Could not determine duration');

  const mime = mimeFromInit(transmuxProbe(head));
  if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) {
    throw new Error(`Browser cannot play these codecs: ${mime}`);
  }

  const mediaSource = new MediaSource();
  const objectUrl = URL.createObjectURL(mediaSource);
  video.src = objectUrl;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MediaSource open timeout')), 10000);
    mediaSource.addEventListener(
      'sourceopen',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

  const sb = mediaSource.addSourceBuffer(mime);
  try {
    mediaSource.duration = duration;
  } catch (_) {}

  // Maps a raw PTS to the presentation timeline, tolerating one 33-bit wrap.
  function ptsToTimeline(pts: number): number {
    return ((((pts - basePts) % PTS_WRAP) + PTS_WRAP) % PTS_WRAP) / PTS_CLOCK;
  }

  // High-bitrate files need bigger read chunks or request latency dominates.
  const avgBytesPerSec = size / duration;
  const chunkSize = Math.min(
    12 * 1024 * 1024,
    Math.max(CHUNK_SIZE, Math.ceil((avgBytesPerSec * 6) / TS_PACKET) * TS_PACKET)
  );

  const queue: Uint8Array[] = [];
  let reachedEnd = false;
  let generation = 0;
  let pendingSeek: number | null = null;
  let pendingLanding: number | null = null;
  // timestampOffset for the next generation's segments; applied between
  // appends because the setter throws while the SourceBuffer is updating
  let pendingOffset: number | null = -(basePts / PTS_CLOCK);
  let destroyed = false;
  let lastRestartAt = 0;

  function pump() {
    if (destroyed || sb.updating) return;
    if (queue.length > 0) {
      if (pendingOffset != null) {
        try {
          sb.timestampOffset = pendingOffset;
          pendingOffset = null;
        } catch (err) {
          console.warn('setting timestampOffset failed', err);
          return;
        }
      }
      const data = queue.shift()!;
      try {
        sb.appendBuffer(data as BufferSource);
      } catch (err) {
        if ((err as DOMException).name === 'QuotaExceededError') {
          queue.unshift(data);
          const evictEnd = Math.max(0, video.currentTime - 30);
          if (evictEnd > 1) {
            try {
              sb.remove(0, evictEnd);
              return;
            } catch (_) {}
          }
        }
        console.warn('appendBuffer failed', err);
      }
      return;
    }
    if (reachedEnd && mediaSource.readyState === 'open') {
      try {
        mediaSource.endOfStream();
      } catch (_) {}
    }
  }

  sb.addEventListener('updateend', () => {
    // After a seek the produced data starts at pendingLanding (give or take
    // keyframe alignment), not exactly at the requested time — once a range
    // shows up near the landing point, jump into it.
    if (pendingSeek != null && pendingLanding != null) {
      for (let i = 0; i < video.buffered.length; i++) {
        const s = video.buffered.start(i);
        const e = video.buffered.end(i);
        if (pendingSeek >= s && pendingSeek < e) {
          pendingSeek = null;
          pendingLanding = null;
          break;
        }
        if (s >= pendingLanding - 5 && s <= pendingLanding + 60 && e - s > 0.5) {
          pendingSeek = null;
          pendingLanding = null;
          video.currentTime = s + 0.1;
          break;
        }
      }
    }
    pump();
  });

  function enqueue(seg: { initSegment: Uint8Array; data: Uint8Array }) {
    const init = seg.initSegment;
    if (init && init.byteLength > 0) {
      const merged = new Uint8Array(init.byteLength + seg.data.byteLength);
      merged.set(init, 0);
      merged.set(seg.data, init.byteLength);
      queue.push(merged);
    } else {
      queue.push(new Uint8Array(seg.data));
    }
    pump();
  }

  function bufferedAhead(): number {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (t >= video.buffered.start(i) - 0.5 && t <= video.buffered.end(i)) {
        return video.buffered.end(i) - t;
      }
    }
    return 0;
  }

  async function streamFrom(
    gen: number,
    startByte: number,
    preloaded: Uint8Array | null,
    signal: AbortSignal
  ) {
    const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true });
    transmuxer.on('data', (seg) => {
      if (gen === generation && !destroyed) enqueue(seg);
    });
    const reframer = new TsReframer();

    let pos = startByte;
    let fetchedSinceSeek = 0;
    try {
      while (pos < size && gen === generation && !destroyed) {
        while (
          !destroyed &&
          gen === generation &&
          (bufferedAhead() > AHEAD_TARGET_SECS || queue.length > 4)
        ) {
          await sleep(500);
        }
        if (gen !== generation || destroyed) return;

        let data: Uint8Array;
        if (preloaded) {
          data = preloaded;
          preloaded = null;
          pos = startByte + data.byteLength;
        } else {
          const end = Math.min(pos + chunkSize, size) - 1;
          data = await readRange(node, pos, end, signal);
          pos = end + 1;
        }
        if (gen !== generation || destroyed) return;

        // Runaway guard: if a seek still hasn't produced a playable range
        // after this much data, something about the mapping is wrong — stop
        // burning bandwidth instead of downloading the rest of the file.
        if (pendingSeek != null) {
          fetchedSinceSeek += data.byteLength;
          if (fetchedSinceSeek > Math.max(64 * 1024 * 1024, chunkSize * 6)) {
            console.error('TS seek produced no playable data, giving up');
            try {
              if (mediaSource.readyState === 'open') mediaSource.endOfStream('network');
            } catch (_) {}
            return;
          }
        } else {
          fetchedSinceSeek = 0;
        }

        const safe = reframer.process(data, pos >= size);
        if (safe.byteLength > 0) {
          transmuxer.push(safe);
          transmuxer.flush();
        }
      }
      if (gen === generation && !destroyed && pos >= size) {
        reachedEnd = true;
        pump();
      }
    } catch (err) {
      if (destroyed || gen !== generation || (err as Error).name === 'AbortError') return;
      console.error('TS streaming failed', err);
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream('network');
      } catch (_) {}
    }
  }

  function alignByte(byte: number): number {
    const clamped = Math.min(Math.max(byte, 0), size - TS_PACKET);
    return Math.floor(clamped / TS_PACKET) * TS_PACKET;
  }

  async function restartAt(t: number) {
    const gen = ++generation;
    aborter.abort();
    aborter = new AbortController();
    const signal = aborter.signal;
    queue.length = 0;
    reachedEnd = false;
    pendingSeek = t;
    pendingLanding = t;
    lastRestartAt = Date.now();

    try {
      // Probe the estimated byte offset and read the actual PTS there: VBR
      // and PTS discontinuities make the proportional estimate land far away,
      // and without knowing the real landing time the data may even be placed
      // outside the seekable range (infinite loading + endless downloads).
      let byte = alignByte((t / duration) * size);
      let probe = await readRange(
        node,
        byte,
        Math.min(byte + PROBE_SIZE, size) - 1,
        signal
      );
      let pts = scanPts(probe, false);
      let landed = pts != null ? ptsToTimeline(pts) : null;

      // One refinement pass using the global average bitrate
      if (landed != null && Math.abs(landed - t) > 8) {
        const byte2 = alignByte(byte - (landed - t) * avgBytesPerSec);
        if (Math.abs(byte2 - byte) > PROBE_SIZE) {
          const probe2 = await readRange(
            node,
            byte2,
            Math.min(byte2 + PROBE_SIZE, size) - 1,
            signal
          );
          const pts2 = scanPts(probe2, false);
          if (pts2 != null) {
            byte = byte2;
            probe = probe2;
            pts = pts2;
            landed = ptsToTimeline(pts2);
          }
        }
      }

      if (gen !== generation || destroyed) return;
      if (pts != null && landed != null) {
        pendingLanding = landed;
        // Place this generation's output at the landing point regardless of
        // what the raw PTS is (handles wraps and discontinuities).
        pendingOffset = landed - pts / PTS_CLOCK;
      }
      await streamFrom(gen, byte, probe, signal);
    } catch (err) {
      if (destroyed || gen !== generation || (err as Error).name === 'AbortError') return;
      console.error('TS seek failed', err);
    }
  }

  function startFromBeginning() {
    const gen = ++generation;
    aborter.abort();
    aborter = new AbortController();
    pendingOffset = -(basePts / PTS_CLOCK);
    streamFrom(gen, 0, head, aborter.signal);
  }

  function onSeeking() {
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      const s = video.buffered.start(i);
      const e = video.buffered.end(i);
      // Enough already buffered at the target — let the browser handle it;
      // the stall handler below restarts the stream if we run dry later.
      if (t >= s - 0.3 && t < e && (e - t > 5 || e >= duration - 1)) return;
    }
    restartAt(t);
  }

  function onWaiting() {
    // Playback ran into the end of a buffered range the current stream is
    // not extending (e.g. after seeking back into an old range).
    if (destroyed || reachedEnd) return;
    if (Date.now() - lastRestartAt < 4000) return;
    if (bufferedAhead() > 2) return;
    if (video.currentTime >= duration - 2) return;
    restartAt(video.currentTime);
  }

  video.addEventListener('seeking', onSeeking);
  video.addEventListener('waiting', onWaiting);

  startFromBeginning();

  return {
    duration,
    destroy() {
      destroyed = true;
      generation++;
      aborter.abort();
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('waiting', onWaiting);
      try {
        if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      } catch (_) {}
      video.removeAttribute('src');
      try {
        video.load();
      } catch (_) {}
      URL.revokeObjectURL(objectUrl);
    },
  };
}
