type HashRequest = {
  id: number;
  type: "hash";
  arrayBuffer: ArrayBuffer;
};

type EncodeWavRequest = {
  id: number;
  type: "encodeWav";
  sampleRate: number;
  numberOfChannels: number;
  length: number;
  channels: ArrayBuffer[];
};

type WorkerRequest = HashRequest | EncodeWavRequest;

function encodeWav(
  sampleRate: number,
  numberOfChannels: number,
  length: number,
  channelBuffers: ArrayBuffer[],
): ArrayBuffer {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = length * blockAlign;

  const wavBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wavBuffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  const channels = channelBuffers.map((buffer) => new Float32Array(buffer));
  let offset = 44;

  for (let i = 0; i < length; i += 1) {
    for (let channel = 0; channel < numberOfChannels; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i] ?? 0));
      const intSample =
        sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return wavBuffer;
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;

  if (message.type === "hash") {
    try {
      const digest = await crypto.subtle.digest("SHA-256", message.arrayBuffer);
      const bytes = new Uint8Array(digest);
      let hash = "";
      for (const byte of bytes) {
        hash += byte.toString(16).padStart(2, "0");
      }
      self.postMessage({ id: message.id, type: "hashResult", hash });
    } catch (error) {
      self.postMessage({
        id: message.id,
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (message.type === "encodeWav") {
    try {
      const wavBuffer = encodeWav(
        message.sampleRate,
        message.numberOfChannels,
        message.length,
        message.channels,
      );
      (self as unknown as { postMessage: (message: unknown, transfer: Transferable[]) => void }).postMessage(
        { id: message.id, type: "encodeWavResult", wavBuffer },
        [wavBuffer],
      );
    } catch (error) {
      self.postMessage({
        id: message.id,
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
};
