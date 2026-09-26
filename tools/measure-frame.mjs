// Measure the real DSH->browser WebSocket frame sizes for a Session history opening.
import fs from 'node:fs';
const { WebSocket } = await import(process.env.WS_MODULE ?? 'ws');

const token = process.argv[2] ?? process.env.DSH_TOKEN;
const sessionId = process.argv[3];
const t0 = Date.now();

// 1. mint the browser cookie exactly like a browser would
const res = await fetch(`http://127.0.0.1:${process.env.DSH_PORT ?? 3080}/?token=${token}`, { redirect: 'manual' });
const setCookie = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
const cookie = setCookie.filter(Boolean).map(c => c.split(';')[0]).join('; ');
console.log(`cookie: ${cookie.slice(0, 40)}… status=${res.status}`);

const ENDPOINT = 'session/follow';
const ws = new WebSocket(`ws://127.0.0.1:${process.env.DSH_PORT ?? 3080}/api/remote.mux`, { headers: { cookie } });
const stats = [];
ws.on('open', () => {
  console.log(`mux open in ${Date.now() - t0}ms`);
  ws.send(JSON.stringify({
    type: 'open',
    streamId: 'diag-1',
    endpoint: ENDPOINT,
    payload: {
      args: {
        request: {
          address: { kind: 'session', sessionId },
          assistantStream: true,
          maxMessages: 500,
          turnWindow: { minMessages: 50, minTurns: 2 },
        },
      },
    },
  }));
});
ws.on('message', (data, binary) => {
  const bytes = Buffer.byteLength(data);
  let desc = '';
  try {
    const o = JSON.parse(data.toString());
    desc = `${o.type}${o.value ? '/' + (o.value.type ?? '') : ''}`;
    if (o.type === 'item' && o.value && o.value.type === 'snapshot') {
      const recs = o.value.records ?? [];
      let recBytes = 0;
      for (const r of recs) recBytes += Buffer.byteLength(JSON.stringify(r));
      desc += ` records=${recs.length} recordsBytes=${(recBytes / 1048576).toFixed(2)}MiB projectionsBytes=${Buffer.byteLength(JSON.stringify(o.value.projections ?? {}))}`;
    }
    if (o.type === 'error') desc += ' ' + JSON.stringify(o.error);
  } catch { desc = 'unparsed'; }
  stats.push({ bytes, desc });
  console.log(`frame ${stats.length}: ${bytes} bytes (${(bytes / 1048576).toFixed(3)} MiB) ${desc}`);
  if (stats.length === 1) {
    setTimeout(() => { ws.send(JSON.stringify({ type: 'cancel', streamId: 'diag-1' })); ws.close(); }, 150);
  }
});
ws.on('error', (e) => console.log('ws error:', e.message));
ws.on('close', (code, reason) => {
  const top = stats[0];
  console.log(`mux closed code=${code} reason=${reason.toString()} frames=${stats.length} elapsed=${Date.now() - t0}ms`);
  if (top) {
    console.log(JSON.stringify({
      sessionId,
      firstFrameBytes: top.bytes,
      firstFrameMiB: +(top.bytes / 1048576).toFixed(3),
      sealedOuterEstMiB: +((top.bytes * 1.334 * 1.334 + 400) / 1048576).toFixed(3),
      relayLimitMiB: 4,
    }, null, 1));
  }
  process.exit(0);
});
