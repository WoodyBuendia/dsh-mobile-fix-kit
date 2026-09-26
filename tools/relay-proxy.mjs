// Transparent WebSocket proxy in front of the dsh-mobile relay.
// Purpose: record the exact size of every outer frame the Companion sends and
// the close codes both directions produce -- without touching the plugin.
// The plugin points at ws://127.0.0.1:9099 (plain) instead of wss://relay.../device.
import fs from 'node:fs';
const { WebSocketServer, WebSocket } = await import(process.env.WS_MODULE ?? 'ws');

const LISTEN_PORT = Number(process.env.PORT ?? 9099);
const UPSTREAM = process.env.UPSTREAM ?? 'wss://relay.dshmobile.online/device';
const LOG = process.env.LOG ?? '/tmp/relayproxy.log';
const MAX_UPSTREAM_PAYLOAD = 128 * 1024 * 1024;

const out = fs.createWriteStream(LOG, { flags: 'a' });
function log(line) {
  const stamp = new Date().toTimeString().slice(0, 8);
  out.write(`${stamp} ${line}\n`);
}

function describe(raw, binary) {
  const bytes = Buffer.byteLength(raw);
  if (binary) return `binary ${bytes}B`;
  let type = '?';
  let extra = '';
  try {
    const msg = JSON.parse(raw.toString());
    type = msg.type ?? '?';
    if (type === 'sealed') {
      const b64 = msg.payload?.ciphertextB64 ?? '';
      // inner plaintext length is (b64len*3/4) - 16 tag bytes
      const inner = Math.floor((b64.length * 3) / 4) - 16;
      extra = ` seq=${msg.payload?.seq} ciphertextB64=${b64.length}B innerPlain=${inner}B (${(inner / 1048576).toFixed(2)}MiB)`;
    }
  } catch {
    type = 'unparsed';
  }
  return `${type} ${bytes}B (${(bytes / 1048576).toFixed(3)}MiB)${extra}`;
}

const wss = new WebSocketServer({ port: LISTEN_PORT, host: '127.0.0.1', maxPayload: MAX_UPSTREAM_PAYLOAD });
log(`=== proxy listening on 127.0.0.1:${LISTEN_PORT} -> ${UPSTREAM} ===`);

wss.on('connection', (down, req) => {
  log(`companion connected from ${req.socket.remoteAddress}`);
  const up = new WebSocket(UPSTREAM, { maxPayload: MAX_UPSTREAM_PAYLOAD });
  const queue = [];
  let upOpen = false;
  let bytesUp = 0;
  let bytesDown = 0;

  up.on('open', () => {
    upOpen = true;
    log('upstream relay connected');
    for (const [data, binary] of queue.splice(0)) up.send(data, { binary });
  });
  up.on('message', (data, binary) => {
    bytesDown += Buffer.byteLength(data);
    log(`relay -> companion  ${describe(data, binary)}  totalDown=${(bytesDown / 1048576).toFixed(2)}MiB`);
    if (down.readyState === WebSocket.OPEN) down.send(data, { binary });
  });
  up.on('close', (code, reason) => {
    log(`UPSTREAM CLOSED code=${code} reason=${JSON.stringify(reason.toString())} bytesCompanionSent=${(bytesUp / 1048576).toFixed(2)}MiB bytesRelaySent=${(bytesDown / 1048576).toFixed(2)}MiB`);
    const forwardable = (code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999);
    if (down.readyState === WebSocket.OPEN) down.close(forwardable ? code : 1011, reason.toString().slice(0, 100));
  });
  up.on('error', (e) => log(`upstream error: ${e.message}`));

  down.on('message', (data, binary) => {
    const size = Buffer.byteLength(data);
    bytesUp += size;
    log(`companion -> relay  ${describe(data, binary)}  totalUp=${(bytesUp / 1048576).toFixed(2)}MiB`);
    if (upOpen) up.send(data, { binary });
    else queue.push([data, binary]);
  });
  down.on('close', (code, reason) => {
    log(`COMPANION CLOSED code=${code} reason=${JSON.stringify(reason.toString())} bytesCompanionSent=${(bytesUp / 1048576).toFixed(2)}MiB`);
    const forwardable = (code >= 1000 && code <= 1014) || (code >= 3000 && code <= 4999);
    if (up.readyState === WebSocket.OPEN) up.close(forwardable ? code : 1000, reason.toString().slice(0, 100));
  });
  down.on('error', (e) => log(`companion error: ${e.message}`));
});
