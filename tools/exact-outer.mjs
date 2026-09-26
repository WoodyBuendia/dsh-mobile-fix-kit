// Deterministic outer-frame size the Companion sends to the relay for one DSH
// WebSocket frame of length L. Mirrors plugin.js (base64) + e2ee.js (seal) + envelope.
import { randomUUID } from 'node:crypto';
export function outerBytesForDshFrame(L, seq = 0) {
  const dshFrame = 'x'.repeat(L);
  const dataB64 = Buffer.from(dshFrame).toString('base64');           // ws_frame payload
  const inner = JSON.stringify({ v: 1, type: 'ws_frame', channel: 'ch_abcdef0123456789', id: randomUUID(), ts: Date.now(), payload: { dataB64, opcode: 1 } });
  const sealed = Buffer.concat([Buffer.from(inner), Buffer.alloc(16)]); // AES-256-GCM tag
  const ciphertextB64 = sealed.toString('base64url');
  const outer = JSON.stringify({ v: 1, type: 'sealed', id: randomUUID(), ts: Date.now(), payload: { accessSessionId: 'access_00000000-0000-4000-8000-000000000000', seq: String(seq), ciphertextB64 } });
  return { outer: Buffer.byteLength(outer), inner: Buffer.byteLength(inner) };
}
if (process.argv[2]) {
  const L = Number(process.argv[2]);
  const r = outerBytesForDshFrame(L);
  console.log(JSON.stringify({ dshFrameBytes: L, dshFrameMiB: +(L/1048576).toFixed(3), outerBytes: r.outer, outerMiB: +(r.outer/1048576).toFixed(3), ratio: +(r.outer/L).toFixed(3), relayLimitMiB: 4, verdict: r.outer > 4*1048576 ? 'RELAY WILL CLOSE 1009' : 'under limit' }, null, 1));
}
