import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mixTracksToWav, ensureMixedWav, MIXED_WAV_NAME } from '../src/voice/mix.js';

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'parley-mix-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function pcm(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

function readWav(path) {
  const buf = readFileSync(path);
  const header = buf.subarray(0, 44);
  const data = buf.subarray(44);
  const samples = [];
  for (let i = 0; i < data.length; i += 2) samples.push(data.readInt16LE(i));
  return { header, samples };
}

test('single track mixes to a valid 16kHz mono WAV with the same samples', async () => {
  const { dir, cleanup } = tmp();
  try {
    const src = join(dir, 'a.pcm');
    writeFileSync(src, pcm([100, -200, 300]));
    const out = await mixTracksToWav([{ path: src, startMs: 5000 }], join(dir, 'out.wav'));
    const { header, samples } = readWav(out);
    assert.equal(header.toString('ascii', 0, 4), 'RIFF');
    assert.equal(header.toString('ascii', 8, 12), 'WAVE');
    assert.equal(header.readUInt16LE(22), 1);       // mono
    assert.equal(header.readUInt32LE(24), 16000);   // 16 kHz
    assert.equal(header.readUInt32LE(40), 6);       // data bytes
    assert.deepEqual(samples, [100, -200, 300]);
  } finally { cleanup(); }
});

test('overlapping tracks sum sample-wise and clamp at the s16 range', async () => {
  const { dir, cleanup } = tmp();
  try {
    const a = join(dir, 'a.pcm');
    const b = join(dir, 'b.pcm');
    writeFileSync(a, pcm([100, 30000, -30000]));
    writeFileSync(b, pcm([50, 30000, -30000]));
    const out = await mixTracksToWav(
      [{ path: a, startMs: 0 }, { path: b, startMs: 0 }],
      join(dir, 'out.wav'),
    );
    const { samples } = readWav(out);
    assert.deepEqual(samples, [150, 32767, -32768]); // sum, clamp high, clamp low
  } finally { cleanup(); }
});

test('a later track is offset by its start time with silence in the gap', async () => {
  const { dir, cleanup } = tmp();
  try {
    const a = join(dir, 'a.pcm');
    const b = join(dir, 'b.pcm');
    writeFileSync(a, pcm([11, 22]));
    writeFileSync(b, pcm([33, 44]));
    // 1 ms apart = 16 samples at 16 kHz.
    const out = await mixTracksToWav(
      [{ path: a, startMs: 1000 }, { path: b, startMs: 1001 }],
      join(dir, 'out.wav'),
    );
    const { samples } = readWav(out);
    assert.equal(samples.length, 18); // 16-sample offset + 2 samples of B
    assert.deepEqual(samples.slice(0, 2), [11, 22]);
    assert.deepEqual(samples.slice(2, 16), Array(14).fill(0)); // zero-filled gap
    assert.deepEqual(samples.slice(16), [33, 44]);
  } finally { cleanup(); }
});

test('mixTracksToWav returns null when there is nothing to mix', async () => {
  const { dir, cleanup } = tmp();
  try {
    assert.equal(await mixTracksToWav([], join(dir, 'out.wav')), null);
    const empty = join(dir, 'empty.pcm');
    writeFileSync(empty, Buffer.alloc(0));
    assert.equal(await mixTracksToWav([{ path: empty, startMs: 0 }], join(dir, 'out.wav')), null);
  } finally { cleanup(); }
});

test('ensureMixedWav builds from the dir tracks and caches the result', async () => {
  const { dir, cleanup } = tmp();
  try {
    const audioDir = join(dir, '7');
    mkdirSync(audioDir);
    writeFileSync(join(audioDir, 'u1_1000.pcm'), pcm([1, 2]));
    writeFileSync(join(audioDir, 'u2_1001.pcm'), pcm([3, 4]));

    const out = await ensureMixedWav(audioDir);
    assert.equal(out, join(audioDir, MIXED_WAV_NAME));
    assert.equal(existsSync(out), true);
    const first = readFileSync(out);

    // Cached: a new .pcm appearing later must not change the existing mix.
    writeFileSync(join(audioDir, 'u3_1002.pcm'), pcm([9, 9]));
    await ensureMixedWav(audioDir);
    assert.deepEqual(readFileSync(out), first);
  } finally { cleanup(); }
});

test('ensureMixedWav returns null for a missing or track-less dir', async () => {
  const { dir, cleanup } = tmp();
  try {
    assert.equal(await ensureMixedWav(join(dir, 'nope')), null);
    const emptyDir = join(dir, '9');
    mkdirSync(emptyDir);
    assert.equal(await ensureMixedWav(emptyDir), null);
  } finally { cleanup(); }
});
