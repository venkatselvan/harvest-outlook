/** Encode a mono waveform as uncompressed little-endian PCM16 WAV. */
export function encodeMonoPcm16(
  samples: Float32Array,
  sampleRate = 16000,
): ArrayBuffer {
  if (sampleRate !== 16000 && sampleRate !== 24000)
    throw new Error("Unsupported transcription sample rate");
  if (!samples.length) throw new Error("The recording is empty");
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const label = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(at + i, value.charCodeAt(i));
  };
  label(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  label(8, "WAVE");
  label(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  label(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => {
    const value = Number.isFinite(sample)
      ? Math.max(-1, Math.min(1, sample))
      : 0;
    view.setInt16(
      44 + i * 2,
      Math.round(value * (value < 0 ? 32768 : 32767)),
      true,
    );
  });
  return bytes;
}

/** Local audio preparation only: no browser recognition or synthesis service. */
export async function prepareTranscriptionWav(
  recording: Blob,
  maxSeconds = 60,
): Promise<Blob> {
  const decoder = new AudioContext();
  try {
    const decoded = await decoder.decodeAudioData(
      await recording.arrayBuffer(),
    );
    const frames = Math.min(
      decoded.length,
      Math.floor(maxSeconds * decoded.sampleRate),
    );
    if (!frames) throw new Error("The recording is empty");
    const offline = new OfflineAudioContext(
      1,
      Math.ceil((frames * 16000) / decoded.sampleRate),
      16000,
    );
    const mono = offline.createBuffer(1, frames, decoded.sampleRate);
    const mixed = mono.getChannelData(0);
    for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
      const samples = decoded.getChannelData(channel);
      for (let frame = 0; frame < frames; frame++)
        mixed[frame] =
          mixed[frame]! + samples[frame]! / decoded.numberOfChannels;
    }
    const source = offline.createBufferSource();
    source.buffer = mono;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    return new Blob([encodeMonoPcm16(resampled.getChannelData(0))], {
      type: "audio/wav",
    });
  } finally {
    await decoder.close();
  }
}
