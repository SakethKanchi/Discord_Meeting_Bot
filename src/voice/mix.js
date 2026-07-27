// Mix a meeting's per-turn PCM tracks (s16le/16kHz/mono, one file per speaking
// turn — see capture.js) into a single meeting-long WAV for download. Tracks
// are placed on a shared timeline by their epoch-ms start offsets (from the
// filename) and summed sample-wise with clamping where speakers overlap.
//
// I/O is chunked read-modify-write against a pre-sized output file, so memory
// stays bounded no matter how long the meeting ran (a WAV hour is ~115 MB).
import { existsSync, readdirSync } from 'node:fs';
import { open, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePcmName, wavHeader } from './audio.js';

const BYTES_PER_SAMPLE = 2;
const SAMPLES_PER_MS = 16; // 16 kHz mono
const CHUNK = 1 << 20; // 1 MiB per read-modify-write window

export const MIXED_WAV_NAME = 'mixed.wav';

/**
 * Mix tracks [{ path, startMs }] into a WAV at outPath.
 * Returns outPath, or null when there is nothing to mix.
 */
export async function mixTracksToWav(tracks, outPath) {
  const sized = [];
  for (const t of tracks) {
    const { size } = await stat(t.path).catch(() => ({ size: 0 }));
    const bytes = size - (size % BYTES_PER_SAMPLE); // ignore a trailing odd byte
    if (bytes >= BYTES_PER_SAMPLE) sized.push({ ...t, bytes });
  }
  if (sized.length === 0) return null;

  const t0 = Math.min(...sized.map((t) => t.startMs));
  for (const t of sized) t.offsetBytes = (t.startMs - t0) * SAMPLES_PER_MS * BYTES_PER_SAMPLE;
  const totalBytes = Math.max(...sized.map((t) => t.offsetBytes + t.bytes));

  const out = await open(outPath, 'w+');
  try {
    await out.write(wavHeader(totalBytes), 0, 44, 0);
    // Extending via truncate zero-fills, so silence between turns needs no writes.
    await out.truncate(44 + totalBytes);
    for (const t of sized) {
      const src = await open(t.path, 'r');
      try {
        for (let pos = 0; pos < t.bytes; pos += CHUNK) {
          const len = Math.min(CHUNK, t.bytes - pos);
          const inBuf = Buffer.alloc(len);
          await src.read(inBuf, 0, len, pos);
          const outPos = 44 + t.offsetBytes + pos;
          const outBuf = Buffer.alloc(len);
          await out.read(outBuf, 0, len, outPos);
          for (let i = 0; i < len; i += BYTES_PER_SAMPLE) {
            const sum = outBuf.readInt16LE(i) + inBuf.readInt16LE(i);
            outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), i);
          }
          await out.write(outBuf, 0, len, outPos);
        }
      } finally { await src.close(); }
    }
  } finally { await out.close(); }
  return outPath;
}

/**
 * Return the path of the meeting dir's mixed WAV, building it from the .pcm
 * tracks on first call (the result is cached next to them as mixed.wav).
 * Returns null when the dir has no usable audio.
 */
export async function ensureMixedWav(audioDir) {
  const outPath = join(audioDir, MIXED_WAV_NAME);
  if (existsSync(outPath)) return outPath;

  let files = [];
  try { files = readdirSync(audioDir).filter((f) => f.endsWith('.pcm')); }
  catch { return null; } // dir gone → no audio
  const tracks = files
    .map((f) => ({ path: join(audioDir, f), startMs: parsePcmName(f).startMs }))
    .filter((t) => Number.isFinite(t.startMs));
  if (tracks.length === 0) return null;

  // Build under a temp name so a crash mid-mix can never serve a half-written WAV.
  const tmpPath = `${outPath}.tmp`;
  try {
    const mixed = await mixTracksToWav(tracks, tmpPath);
    if (!mixed) return null;
    await rename(tmpPath, outPath);
    return outPath;
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}
