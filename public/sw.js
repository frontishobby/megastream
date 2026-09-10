const SCOPE_PATH = new URL(self.registration.scope).pathname;
const STREAM_PATH = SCOPE_PATH + '__mega_stream/';
const sessions = new Map();

// Two ways to serve a range:
//
// * direct — the page hands over the node's AES key and MEGA download URL at
//   registration, and the worker fetches ciphertext straight from the MEGA CDN
//   as one streaming request, decrypting with WebCrypto AES-CTR on the way
//   through. First bytes arrive as soon as the CDN sends them, cancel aborts
//   the fetch, and the queue's backpressure reaches TCP flow control.
//
// * client pull — fallback when the page couldn't provide key/URL: the worker
//   asks the page for the range and the page streams it through megajs.
//
// An open-ended `bytes=N-` used to be answered with "N through end of file", so
// every seek made the page pull the whole remainder off MEGA. Answering with a
// short window is an ordinary 206; the browser just asks for the next one.
// Direct streams only pay a cheap fetch reopen per boundary, so they get a
// large window. The pull path buffers a whole window in the page when the
// consumer stops reading, so it stays small.
const MAX_WINDOW_DIRECT = 64 * 1024 * 1024;
const MAX_WINDOW_PULL = 16 * 1024 * 1024;

// The <video> element stops *reading* a response once its buffer is full but
// keeps the connection open, so the queue has to push back on the source
// rather than accept chunks forever.
const STREAM_HIGH_WATER = 4 * 1024 * 1024;

const DIRECT_RETRIES = 3;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || typeof data !== 'object') return;
  if (data.type === 'register-session') {
    sessions.set(data.sessionId, makeSession(data, event.source && event.source.id));
    const port = event.ports && event.ports[0];
    if (port) {
      try { port.postMessage({ type: 'session-registered' }); } catch (_) {}
      try { port.close(); } catch (_) {}
    }
  } else if (data.type === 'unregister-session') {
    sessions.delete(data.sessionId);
  }
});

function makeSession(info, clientId) {
  const d = info.direct;
  const direct = d && d.url && d.aesKey && d.nonce
    ? { url: d.url, aesKey: d.aesKey, nonce: new Uint8Array(d.nonce), cryptoKey: null }
    : null;
  return { size: info.size, mimeType: info.mimeType, clientId, direct };
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith(STREAM_PATH)) return;
  const sessionId = url.pathname.slice(STREAM_PATH.length);
  event.respondWith((async () => {
    // The browser terminates idle service workers, wiping the in-memory
    // session map mid-playback; the page still holds the session, so ask
    // open clients to re-register before giving up with a 404.
    let session = sessions.get(sessionId);
    if (!session) session = await resolveSessionFromClients(sessionId);
    if (!session) return new Response('Unknown session', { status: 404 });
    return handleStreamRequest(event.request, sessionId, session, url);
  })());
});

function askClient(client, message, timeoutMs) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      try { channel.port1.close(); } catch (_) {}
      resolve(null);
    }, timeoutMs);
    channel.port1.onmessage = (e) => {
      clearTimeout(timer);
      try { channel.port1.close(); } catch (_) {}
      resolve(e.data || null);
    };
    try {
      client.postMessage(message, [channel.port2]);
    } catch (_) {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function resolveSessionFromClients(sessionId) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    const info = await askClient(client, { type: 'resolve-session', sessionId }, 2000);
    if (info && info.type === 'session-info' && info.found) {
      const session = makeSession(info, client.id);
      sessions.set(sessionId, session);
      return session;
    }
  }
  return null;
}

async function findClient(session) {
  let client = session.clientId ? await self.clients.get(session.clientId) : null;
  if (!client) {
    const all = await self.clients.matchAll({ type: 'window' });
    client = all[0] || null;
  }
  return client;
}

async function handleStreamRequest(request, sessionId, session, url) {
  const { size, mimeType } = session;
  const rangeHeader = request.headers.get('range');

  let start = 0;
  let end = size - 1;
  let status = 200;
  const headers = new Headers({
    'Content-Type': mimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });

  // ?download=1 turns a navigation to this URL into a file save: the
  // attachment disposition hands the response to the download manager
  // without leaving the page (StreamSaver-style).
  // A save is a genuine full-file transfer and must not be windowed.
  const isDownload = !!(url && url.searchParams.get('download') === '1');
  if (isDownload) {
    const name = url.searchParams.get('name') || 'download';
    headers.set(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`
    );
  }

  if (rangeHeader) {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (match) {
      start = parseInt(match[1], 10);
      if (match[2]) end = parseInt(match[2], 10);
      if (end >= size) end = size - 1;
      if (start > end || start >= size) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: { 'Content-Range': `bytes */${size}` },
        });
      }
      status = 206;
    }
  }

  // A GET with no Range header asks for the whole resource, and Chrome's media
  // loader sends one once playback settles — answering it in full puts the
  // full-file transfer straight back. Windowing it into a 206 keeps it bounded
  // and the loader simply asks for the next slice. HEAD has to keep describing
  // the whole resource, and a save is a real full-file transfer.
  const windowed = !isDownload && request.method !== 'HEAD';
  const maxWindow = session.direct ? MAX_WINDOW_DIRECT : MAX_WINDOW_PULL;
  if (windowed && end - start + 1 > maxWindow) {
    end = start + maxWindow - 1;
    status = 206;
  }

  if (status === 206) {
    headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  }

  headers.set('Content-Length', String(end - start + 1));

  if (request.method === 'HEAD') {
    return new Response(null, { status, headers });
  }

  if (session.direct) {
    const stream = createDirectStream(session, sessionId, start, end);
    return new Response(stream, { status, headers });
  }

  const client = await findClient(session);
  if (!client) {
    return new Response('No client available', { status: 410 });
  }
  const stream = createClientPullStream(client, sessionId, start, end);
  return new Response(stream, { status, headers });
}

// ---------------------------------------------------------------------------
// Direct path: fetch ciphertext from the MEGA CDN and decrypt in the worker.
// ---------------------------------------------------------------------------

// MEGA files are AES-128-CTR with an 8-byte nonce in the top half of the
// counter block and the block index in the bottom half — exactly WebCrypto's
// AES-CTR with a 64-bit counter. Decryption is encryption in CTR mode.
class CtrDecryptor {
  constructor(cryptoKey, nonce, blockIndex) {
    this.key = cryptoKey;
    this.counter = new Uint8Array(16);
    this.counter.set(nonce.subarray(0, 8), 0);
    this.block = BigInt(blockIndex);
    this.carry = new Uint8Array(0);
  }

  async update(chunk) {
    let data = chunk;
    if (this.carry.length) {
      data = new Uint8Array(this.carry.length + chunk.length);
      data.set(this.carry, 0);
      data.set(chunk, this.carry.length);
    }
    const full = data.length - (data.length % 16);
    this.carry = data.slice(full);
    if (!full) return new Uint8Array(0);
    return new Uint8Array(await this.run(data.subarray(0, full)));
  }

  // The last block of a file is short; pad it out to run the cipher and trim.
  async final() {
    if (!this.carry.length) return new Uint8Array(0);
    const padded = new Uint8Array(16);
    padded.set(this.carry);
    const out = new Uint8Array(await this.run(padded));
    const res = out.subarray(0, this.carry.length);
    this.carry = new Uint8Array(0);
    return res;
  }

  async run(data) {
    new DataView(this.counter.buffer).setBigUint64(8, this.block);
    const out = await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: this.counter, length: 64 },
      this.key,
      data
    );
    this.block += BigInt(data.length / 16);
    return out;
  }
}

function getCryptoKey(direct) {
  if (!direct.cryptoKey) {
    direct.cryptoKey = crypto.subtle.importKey('raw', direct.aesKey, { name: 'AES-CTR' }, false, ['encrypt']);
  }
  return direct.cryptoKey;
}

// Download URLs from MEGA's `g` call expire; when the CDN rejects one, ask the
// page for a fresh one before giving up.
async function refreshDownloadUrl(session, sessionId) {
  const client = await findClient(session);
  if (!client) return null;
  const reply = await askClient(client, { type: 'refresh-url', sessionId }, 15000);
  return reply && reply.type === 'url' && typeof reply.url === 'string' ? reply.url : null;
}

async function notifyStreamError(session, sessionId, message) {
  const client = await findClient(session);
  if (!client) return;
  try { client.postMessage({ type: 'stream-error', sessionId, message }); } catch (_) {}
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function createDirectStream(session, sessionId, start, end) {
  const direct = session.direct;
  let reader = null;
  let abort = null;
  let decryptor = null;
  let skip = 0;
  let offset = start; // next plaintext byte to hand to the consumer
  let attempts = 0;
  let refreshed = false;
  let cancelled = false;

  const closeReader = () => {
    try { abort && abort.abort(); } catch (_) {}
    reader = null;
    abort = null;
    decryptor = null;
  };

  // (Re)open the CDN request from the current offset. CTR needs a 16-byte
  // aligned start, so back up to the block boundary and drop the lead bytes.
  const open = async () => {
    const aligned = offset - (offset % 16);
    skip = offset - aligned;
    abort = new AbortController();
    const res = await fetch(`${direct.url}/${aligned}-${end}`, {
      signal: abort.signal,
      cache: 'no-store',
    });
    if (res.status === 509) {
      const left = res.headers.get('x-mega-time-left');
      const err = new Error('Bandwidth limit reached: ' + left + ' seconds until it resets');
      err.fatal = true;
      throw err;
    }
    if (!res.ok) {
      if (!refreshed && (res.status === 403 || res.status === 404 || res.status === 410)) {
        refreshed = true;
        const url = await refreshDownloadUrl(session, sessionId);
        if (url) {
          direct.url = url;
          return open();
        }
      }
      const err = new Error('MEGA returned a ' + res.status + ' status code');
      err.fatal = res.status === 403 || res.status === 404 || res.status === 410;
      throw err;
    }
    if (!res.body) throw new Error('Missing response body');
    reader = res.body.getReader();
    decryptor = new CtrDecryptor(await getCryptoKey(direct), direct.nonce, aligned / 16);
  };

  const pull = async (controller) => {
    while (true) {
      if (cancelled) return;
      try {
        if (!reader) await open();
        const { done, value } = await reader.read();
        let plain = done ? await decryptor.final() : await decryptor.update(value);
        if (skip && plain.length) {
          const s = Math.min(skip, plain.length);
          plain = plain.subarray(s);
          skip -= s;
        }
        if (plain.length) {
          offset += plain.length;
          controller.enqueue(plain);
        }
        if (done) {
          // A CDN connection that closes early is a transfer failure, not EOF.
          if (offset <= end) throw new Error('MEGA connection closed before the range completed');
          controller.close();
          return;
        }
        if (plain.length) return;
      } catch (err) {
        if (cancelled) return;
        closeReader();
        attempts++;
        if (err && err.fatal || attempts > DIRECT_RETRIES) {
          const message = (err && err.message) || 'Stream error';
          notifyStreamError(session, sessionId, message);
          try { controller.error(new Error(message)); } catch (_) {}
          return;
        }
        console.warn(`Range ${start}-${end} failed at ${offset} (attempt ${attempts}/${DIRECT_RETRIES}), retrying:`, err && err.message || err);
        await sleep(1000 * attempts);
      }
    }
  };

  return new ReadableStream({
    pull,
    cancel() {
      cancelled = true;
      closeReader();
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER }));
}

// ---------------------------------------------------------------------------
// Fallback path: the page streams the range through megajs.
// ---------------------------------------------------------------------------

function createClientPullStream(client, sessionId, start, end) {
  let port;
  let settled = false;
  let paused = false;
  return new ReadableStream({
    start(controller) {
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (e) => {
        const msg = e.data;
        if (!msg || settled) return;
        if (msg.type === 'chunk') {
          try {
            controller.enqueue(new Uint8Array(msg.chunk));
          } catch (_) {}
          // desiredSize counts bytes here (ByteLengthQueuingStrategy below).
          if (!paused && controller.desiredSize !== null && controller.desiredSize <= 0) {
            paused = true;
            try { port.postMessage({ type: 'pause' }); } catch (_) {}
          }
        } else if (msg.type === 'end') {
          settled = true;
          try { controller.close(); } catch (_) {}
          try { port.close(); } catch (_) {}
        } else if (msg.type === 'error') {
          settled = true;
          try { controller.error(new Error(msg.message || 'Stream error')); } catch (_) {}
          try { port.close(); } catch (_) {}
        }
      };
      client.postMessage(
        { type: 'fetch-range', sessionId, start, end },
        [channel.port2]
      );
    },
    pull(controller) {
      if (paused && controller.desiredSize !== null && controller.desiredSize > 0) {
        paused = false;
        try { port && port.postMessage({ type: 'resume' }); } catch (_) {}
      }
    },
    cancel() {
      settled = true;
      // The page closes the port once it has torn its megajs stream down;
      // closing it here can drop the cancel and leave the download running.
      try { port && port.postMessage({ type: 'cancel' }); } catch (_) {}
    },
  }, new ByteLengthQueuingStrategy({ highWaterMark: STREAM_HIGH_WATER }));
}
