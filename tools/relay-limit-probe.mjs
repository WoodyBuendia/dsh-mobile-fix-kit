const { WebSocket } = await import(process.env.WS_MODULE ?? 'ws');
const sizeMiB = Number(process.argv[2] ?? 5);
const url = 'wss://relay.dshmobile.online/device';
const payload = 'x'.repeat(Math.round(sizeMiB * 1024 * 1024));
const ws = new WebSocket(url, { maxPayload: 128 * 1024 * 1024 });
const t0 = Date.now();
ws.on('open', () => {
  console.log(`connected (${Date.now() - t0}ms); sending auth with bogus credentials`);
  ws.send(JSON.stringify({ v: 1, type: 'auth', id: 'probe-1', ts: Date.now(), payload: { deviceId: 'dev_probe_nonexistent', deviceToken: 'probe' } }));
  setTimeout(() => {
    console.log(`sending oversized frame of ${sizeMiB} MiB`);
    ws.send(JSON.stringify({ v: 1, type: 'sealed', id: 'probe-2', ts: Date.now(), payload: { accessSessionId: 'access_probe', seq: '0', ciphertextB64: payload } }));
  }, 700);
});
ws.on('message', (d) => console.log('recv:', d.toString().slice(0, 160)));
ws.on('error', (e) => console.log('ws error:', e.message));
ws.on('close', (code, reason) => {
  console.log(`CLOSED code=${code} reason=${JSON.stringify(reason.toString())} after ${Date.now() - t0}ms`);
  process.exit(0);
});
setTimeout(() => { console.log('no close within 12s'); ws.terminate(); process.exit(0); }, 12000);
