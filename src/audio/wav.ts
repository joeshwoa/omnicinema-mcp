/**
 * Minimal, dependency-free WAV (PCM16) writer + duration reader.
 *
 * Used by the local synthesis fallback so the pipeline can always produce a real,
 * measurable audio file offline — and report an exact millisecond duration to the
 * master sequencer.
 */
import fs from "node:fs";
import path from "node:path";

export interface WavInfo {
  durationMs: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

/** Write a mono Float32 sample buffer (values in [-1, 1]) as a PCM16 WAV. */
export function writeWavPcm16(dest: string, samples: Float32Array, sampleRate: number): WavInfo {
  const channels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const dataSize = samples.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byte rate
  buffer.writeUInt16LE(channels * bytesPerSample, 32); // block align
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    buffer.writeInt16LE(Math.round(clamped * 32767), offset);
    offset += 2;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return {
    durationMs: Math.round((samples.length / sampleRate) * 1000),
    sampleRate,
    channels,
    bitsPerSample,
  };
}

/** Read a WAV file's fmt + data chunks and compute its precise duration. */
export function readWavInfo(filePath: string): WavInfo | null {
  const buf = fs.readFileSync(filePath);
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataSize = 0;
  let byteRate = 0;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      byteRate = buf.readUInt32LE(body + 8);
      bitsPerSample = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }
  if (!byteRate || !dataSize) return null;
  return {
    durationMs: Math.round((dataSize / byteRate) * 1000),
    sampleRate,
    channels,
    bitsPerSample,
  };
}
