"use client";

import { Midi } from "@tonejs/midi";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import PianoKeyboard, { type Note } from "@/components/piano-visualizer";
import { useWindowResolution } from "@/hooks/window-resolution";
import { useSearchParams } from "next/navigation";

type TempoSegment = {
  startTick: number;
  startSecond: number;
  ticksPerSecond: number;
};

type PlaybackNote = {
  startSecond: number;
  endSecond: number;
  midi: number;
  velocity: number;
};

type CachedRenderMeta = {
  notes: Note[];
  ticksPerQuarter: number;
  quartersPerBar: number;
  tempoSegments: TempoSegment[];
  totalTicks: number;
};

type CachedRenderEntry = CachedRenderMeta & {
  audioUrl: string;
  blobSize: number;
  lastUsed: number;
};

type PersistentRenderEntry = CachedRenderMeta & {
  hash: string;
  audioBlob: Blob;
  blobSize: number;
  lastAccessed: number;
  createdAt: number;
};

type WorkerRequestType = "hash" | "encodeWav";

type WorkerHashResult = { id: number; type: "hashResult"; hash: string };
type WorkerEncodeResult = {
  id: number;
  type: "encodeWavResult";
  wavBuffer: ArrayBuffer;
};
type WorkerError = { id: number; type: "error"; error: string };
type WorkerResponse = WorkerHashResult | WorkerEncodeResult | WorkerError;

type WorkerPending = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

const DEFAULT_TEMPO_BPM = 120;
const PIANO_SAMPLES_BASE_URL = "/piano-samples/";
const VISUALIZER_CACHE_DB = "visualizer-render-cache";
const VISUALIZER_CACHE_STORE = "renders";
const VISUALIZER_CACHE_VERSION = 1;
const VISUALIZER_CACHE_KEY_PREFIX = "v1:";
const MEMORY_CACHE_MAX_ENTRIES = 8;
const MEMORY_CACHE_MAX_BYTES = 250 * 1024 * 1024;
const PERSISTENT_CACHE_MAX_ENTRIES = 20;
const PERSISTENT_CACHE_MAX_BYTES = 800 * 1024 * 1024;

const PIANO_SAMPLE_URLS = {
  A0: "A0.mp3",
  C1: "C1.mp3",
  "D#1": "Ds1.mp3",
  "F#1": "Fs1.mp3",
  A1: "A1.mp3",
  C2: "C2.mp3",
  "D#2": "Ds2.mp3",
  "F#2": "Fs2.mp3",
  A2: "A2.mp3",
  C3: "C3.mp3",
  "D#3": "Ds3.mp3",
  "F#3": "Fs3.mp3",
  A3: "A3.mp3",
  C4: "C4.mp3",
  "D#4": "Ds4.mp3",
  "F#4": "Fs4.mp3",
  A4: "A4.mp3",
  C5: "C5.mp3",
  "D#5": "Ds5.mp3",
  "F#5": "Fs5.mp3",
  A5: "A5.mp3",
  C6: "C6.mp3",
  "D#6": "Ds6.mp3",
  "F#6": "Fs6.mp3",
  A6: "A6.mp3",
  C7: "C7.mp3",
  "D#7": "Ds7.mp3",
  "F#7": "Fs7.mp3",
  A7: "A7.mp3",
  C8: "C8.mp3",
} as const;

function buildTempoSegments(
  ppq: number,
  tempos: Array<{ ticks: number; bpm: number }>,
): TempoSegment[] {
  const sortedTempos = tempos
    .filter((tempo) => Number.isFinite(tempo.bpm) && tempo.bpm > 0)
    .sort((a, b) => a.ticks - b.ticks);

  const normalizedTempos =
    sortedTempos.length === 0
      ? [{ ticks: 0, bpm: DEFAULT_TEMPO_BPM }]
      : sortedTempos[0].ticks === 0
        ? sortedTempos
        : [{ ticks: 0, bpm: DEFAULT_TEMPO_BPM }, ...sortedTempos];

  const segments: TempoSegment[] = [];
  let currentSecond = 0;

  for (let i = 0; i < normalizedTempos.length; i += 1) {
    const current = normalizedTempos[i];
    const next = normalizedTempos[i + 1];
    const ticksPerSecond = (ppq * current.bpm) / 60;

    segments.push({
      startTick: current.ticks,
      startSecond: currentSecond,
      ticksPerSecond,
    });

    if (next) {
      const tickDelta = Math.max(0, next.ticks - current.ticks);
      currentSecond += tickDelta / ticksPerSecond;
    }
  }

  return segments;
}

function secondsToTicks(
  seconds: number,
  segments: TempoSegment[],
  totalTicks: number,
): number {
  if (segments.length === 0 || seconds <= 0) {
    return 0;
  }

  let activeIndex = segments.length - 1;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (
      seconds >= segments[i].startSecond &&
      seconds < segments[i + 1].startSecond
    ) {
      activeIndex = i;
      break;
    }
  }

  const activeSegment = segments[activeIndex];
  const tickValue =
    activeSegment.startTick +
    Math.max(0, seconds - activeSegment.startSecond) *
    activeSegment.ticksPerSecond;

  return Math.min(totalTicks, tickValue);
}

function ticksToSeconds(ticks: number, segments: TempoSegment[]): number {
  if (segments.length === 0 || ticks <= 0) {
    return 0;
  }

  let activeIndex = segments.length - 1;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (ticks >= segments[i].startTick && ticks < segments[i + 1].startTick) {
      activeIndex = i;
      break;
    }
  }

  const activeSegment = segments[activeIndex];
  return (
    activeSegment.startSecond +
    Math.max(0, ticks - activeSegment.startTick) / activeSegment.ticksPerSecond
  );
}

function openCacheDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !window.indexedDB) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const request = window.indexedDB.open(
      VISUALIZER_CACHE_DB,
      VISUALIZER_CACHE_VERSION,
    );

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VISUALIZER_CACHE_STORE)) {
        db.createObjectStore(VISUALIZER_CACHE_STORE, { keyPath: "hash" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function idbGetRender(hash: string): Promise<PersistentRenderEntry | null> {
  const db = await openCacheDb();
  if (!db) {
    return null;
  }

  return new Promise((resolve) => {
    const tx = db.transaction(VISUALIZER_CACHE_STORE, "readonly");
    const store = tx.objectStore(VISUALIZER_CACHE_STORE);
    const request = store.get(hash);

    request.onsuccess = () => {
      const result = request.result as PersistentRenderEntry | undefined;
      resolve(result ?? null);
    };
    request.onerror = () => resolve(null);
  });
}

async function idbPutRender(entry: PersistentRenderEntry): Promise<void> {
  const db = await openCacheDb();
  if (!db) {
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(VISUALIZER_CACHE_STORE, "readwrite");
    tx.objectStore(VISUALIZER_CACHE_STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

async function idbPruneLru(): Promise<void> {
  const db = await openCacheDb();
  if (!db) {
    return;
  }

  const entries = await new Promise<PersistentRenderEntry[]>((resolve) => {
    const tx = db.transaction(VISUALIZER_CACHE_STORE, "readonly");
    const request = tx.objectStore(VISUALIZER_CACHE_STORE).getAll();
    request.onsuccess = () =>
      resolve((request.result as PersistentRenderEntry[] | undefined) ?? []);
    request.onerror = () => resolve([]);
  });

  if (entries.length === 0) {
    return;
  }

  const sorted = [...entries].sort((a, b) => b.lastAccessed - a.lastAccessed);
  let totalBytes = sorted.reduce((sum, item) => sum + (item.blobSize || 0), 0);

  const toDelete: string[] = [];
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const item = sorted[i];
    const tooManyEntries = sorted.length - toDelete.length > PERSISTENT_CACHE_MAX_ENTRIES;
    const tooManyBytes = totalBytes > PERSISTENT_CACHE_MAX_BYTES;
    if (!tooManyEntries && !tooManyBytes) {
      break;
    }
    toDelete.push(item.hash);
    totalBytes -= item.blobSize || 0;
  }

  if (toDelete.length === 0) {
    return;
  }

  await new Promise<void>((resolve) => {
    const tx = db.transaction(VISUALIZER_CACHE_STORE, "readwrite");
    const store = tx.objectStore(VISUALIZER_CACHE_STORE);
    for (const hash of toDelete) {
      store.delete(hash);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
}

function memoryCacheSize(cache: Map<string, CachedRenderEntry>): number {
  let total = 0;
  for (const entry of cache.values()) {
    total += entry.blobSize;
  }
  return total;
}

function createSamplerOrFallback(): Promise<Tone.Sampler | Tone.PolySynth<Tone.Synth>> {
  return new Promise((resolve) => {
    const sampler = new Tone.Sampler({
      urls: PIANO_SAMPLE_URLS,
      baseUrl: PIANO_SAMPLES_BASE_URL,
      attack: 0,
      release: 1.2,
      onload: () => {
        sampler.volume.value = -3;
        resolve(sampler.toDestination());
      },
      onerror: () => {
        sampler.dispose();
        const fallback = new Tone.PolySynth(Tone.Synth, {
          oscillator: { type: "triangle" },
          envelope: {
            attack: 0.01,
            decay: 0.08,
            sustain: 0.35,
            release: 0.12,
          },
        }).toDestination();
        fallback.volume.value = -10;
        resolve(fallback);
      },
    });
  });
}

function VisualizerContent() {
  const searchParams = useSearchParams();
  const fileUrl = searchParams.get("file");

  const [notes, setNotes] = useState<Note[]>([]);
  const [ticksPerQuarter, setTicksPerQuarter] = useState(0);
  const [quartersPerBar, setQuartersPerBar] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [audioFileURL, setAudioFileURL] = useState<string | undefined>(
    "/silent.mp3",
  );

  const resolution = useWindowResolution();

  const audioRef = useRef<HTMLAudioElement>(null);
  const positionRef = useRef(0);
  const loadedFileUrlRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);

  const tempoSegmentsRef = useRef<TempoSegment[]>([]);
  const totalTicksRef = useRef(0);

  const memoryCacheRef = useRef<Map<string, CachedRenderEntry>>(new Map());
  const workerRef = useRef<Worker | null>(null);
  const workerPendingRef = useRef<Map<number, WorkerPending>>(new Map());
  const workerRequestIdRef = useRef(0);

  const getWorker = useCallback(() => {
    if (!workerRef.current) {
      const worker = new Worker(
        new URL("../../workers/visualizer-audio.worker.ts", import.meta.url),
      );

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const data = event.data;
        const pending = workerPendingRef.current.get(data.id);
        if (!pending) {
          return;
        }
        workerPendingRef.current.delete(data.id);

        if (data.type === "error") {
          pending.reject(new Error(data.error));
          return;
        }

        if (data.type === "hashResult") {
          pending.resolve(data.hash);
          return;
        }

        pending.resolve(data.wavBuffer);
      };

      worker.onerror = (error) => {
        for (const pending of workerPendingRef.current.values()) {
          pending.reject(error);
        }
        workerPendingRef.current.clear();
      };

      workerRef.current = worker;
    }

    return workerRef.current;
  }, []);

  const requestWorker = useCallback(
    (
      type: WorkerRequestType,
      payload: Record<string, unknown>,
      transfer: Transferable[] = [],
    ): Promise<unknown> => {
      const worker = getWorker();
      const id = ++workerRequestIdRef.current;

      return new Promise((resolve, reject) => {
        workerPendingRef.current.set(id, { resolve, reject });
        worker.postMessage({ id, type, ...payload }, transfer);
      });
    },
    [getWorker],
  );

  const hashMidiBuffer = useCallback(
    async (arrayBuffer: ArrayBuffer): Promise<string> => {
      const copy = arrayBuffer.slice(0);
      const hash = await requestWorker("hash", { arrayBuffer: copy }, [copy]);
      return hash as string;
    },
    [requestWorker],
  );

  const encodeWavInWorker = useCallback(
    async (audioBuffer: AudioBuffer): Promise<Blob> => {
      const channels = Array.from(
        { length: audioBuffer.numberOfChannels },
        (_, i) => audioBuffer.getChannelData(i).slice(),
      );
      const channelBuffers = channels.map((channel) => channel.buffer);

      const wavBuffer = (await requestWorker(
        "encodeWav",
        {
          sampleRate: audioBuffer.sampleRate,
          numberOfChannels: audioBuffer.numberOfChannels,
          length: audioBuffer.length,
          channels: channelBuffers,
        },
        channelBuffers,
      )) as ArrayBuffer;

      return new Blob([wavBuffer], { type: "audio/wav" });
    },
    [requestWorker],
  );

  const touchMemoryEntry = useCallback((hash: string) => {
    const entry = memoryCacheRef.current.get(hash);
    if (!entry) {
      return;
    }
    entry.lastUsed = Date.now();
    memoryCacheRef.current.set(hash, entry);
  }, []);

  const pruneMemoryLru = useCallback(() => {
    const cache = memoryCacheRef.current;
    if (cache.size === 0) {
      return;
    }

    let totalBytes = memoryCacheSize(cache);
    const entries = [...cache.entries()].sort(
      (a, b) => a[1].lastUsed - b[1].lastUsed,
    );

    for (const [hash, entry] of entries) {
      const tooManyEntries = cache.size > MEMORY_CACHE_MAX_ENTRIES;
      const tooManyBytes = totalBytes > MEMORY_CACHE_MAX_BYTES;
      if (!tooManyEntries && !tooManyBytes) {
        break;
      }

      URL.revokeObjectURL(entry.audioUrl);
      cache.delete(hash);
      totalBytes -= entry.blobSize;
    }
  }, []);

  const setMemoryEntry = useCallback(
    (hash: string, entry: CachedRenderEntry) => {
      const existing = memoryCacheRef.current.get(hash);
      if (existing && existing.audioUrl !== entry.audioUrl) {
        URL.revokeObjectURL(existing.audioUrl);
      }
      memoryCacheRef.current.set(hash, entry);
      pruneMemoryLru();
    },
    [pruneMemoryLru],
  );

  const applyCachedEntry = useCallback((entry: CachedRenderEntry) => {
    tempoSegmentsRef.current = entry.tempoSegments;
    totalTicksRef.current = entry.totalTicks;
    positionRef.current = 0;
    setAudioFileURL(entry.audioUrl);
    setNotes(entry.notes);
    setTicksPerQuarter(entry.ticksPerQuarter);
    setQuartersPerBar(entry.quartersPerBar);
  }, []);

  const renderAudioOnClient = useCallback(
    async (playbackNotes: PlaybackNote[], durationSeconds: number): Promise<Blob> => {
      const rendered = await Tone.Offline(async () => {
        const instrument = await createSamplerOrFallback();

        for (const note of playbackNotes) {
          const duration = Math.max(0.01, note.endSecond - note.startSecond);
          const velocity = Math.max(0.03, Math.min(1, note.velocity));

          instrument.triggerAttackRelease(
            Tone.Frequency(note.midi, "midi").toNote(),
            duration,
            note.startSecond,
            velocity,
          );
        }
      }, durationSeconds + 0.1, 2, 44100);

      const audioBuffer = rendered.get();
      if (!audioBuffer) {
        throw new Error("Offline render failed: empty audio buffer");
      }

      return encodeWavInWorker(audioBuffer);
    },
    [encodeWavInWorker],
  );

  const processMidiFile = useCallback(
    async (file: File) => {
      setIsProcessing(true);

      const audioElement = audioRef.current;
      if (audioElement) {
        audioElement.pause();
        audioElement.currentTime = 0;
      }

      setAudioFileURL("/silent.mp3");

      try {
        const arrayBuffer = await file.arrayBuffer();
        const midiHash = await hashMidiBuffer(arrayBuffer);
        const cacheKey = `${VISUALIZER_CACHE_KEY_PREFIX}${midiHash}`;

        const memoryEntry = memoryCacheRef.current.get(cacheKey);
        if (memoryEntry) {
          touchMemoryEntry(cacheKey);
          applyCachedEntry(memoryEntry);
          return;
        }

        const persistentEntry = await idbGetRender(cacheKey);
        if (persistentEntry) {
          const audioUrl = URL.createObjectURL(persistentEntry.audioBlob);
          const hydratedEntry: CachedRenderEntry = {
            audioUrl,
            blobSize: persistentEntry.blobSize,
            lastUsed: Date.now(),
            notes: persistentEntry.notes,
            ticksPerQuarter: persistentEntry.ticksPerQuarter,
            quartersPerBar: persistentEntry.quartersPerBar,
            tempoSegments: persistentEntry.tempoSegments,
            totalTicks: persistentEntry.totalTicks,
          };

          setMemoryEntry(cacheKey, hydratedEntry);
          applyCachedEntry(hydratedEntry);

          void idbPutRender({
            ...persistentEntry,
            lastAccessed: Date.now(),
          }).then(() => idbPruneLru());

          return;
        }

        const midi = new Midi(arrayBuffer);

        const [nom, denom] = midi.header.timeSignatures[0]?.timeSignature ?? [4, 4];
        const newQpB = Math.max(1, nom * (4 / denom));
        const newTpQ = midi.header.ppq || 480;

        const tempoSegments = buildTempoSegments(
          newTpQ,
          midi.header.tempos.map((tempo) => ({
            ticks: tempo.ticks,
            bpm: tempo.bpm,
          })),
        );

        const barTicks = newTpQ * newQpB;
        const barSeconds = ticksToSeconds(barTicks, tempoSegments);

        const nextNotes = midi.tracks.flatMap((track, index) =>
          track.notes.map((note) => ({
            beginTime: note.ticks + barTicks,
            endTime: note.ticks + note.durationTicks + barTicks,
            midi: note.midi,
            index,
          })),
        );

        const playbackNotes = midi.tracks
          .flatMap((track) =>
            track.notes.map((note) => ({
              startSecond: note.time + barSeconds,
              endSecond: note.time + note.duration + barSeconds,
              midi: note.midi,
              velocity: note.velocity,
            })),
          )
          .sort((a, b) => a.startSecond - b.startSecond);

        const durationSeconds =
          Math.max(
            midi.duration + barSeconds,
            playbackNotes[playbackNotes.length - 1]?.endSecond ?? 0,
          ) + barSeconds;

        const renderedWavBlob = await renderAudioOnClient(
          playbackNotes,
          durationSeconds,
        );

        const totalTicks = nextNotes.reduce(
          (maxTicks, note) => Math.max(maxTicks, note.endTime),
          0,
        );

        const cacheEntry: CachedRenderEntry = {
          audioUrl: URL.createObjectURL(renderedWavBlob),
          blobSize: renderedWavBlob.size,
          lastUsed: Date.now(),
          notes: nextNotes,
          ticksPerQuarter: newTpQ,
          quartersPerBar: newQpB,
          tempoSegments,
          totalTicks,
        };

        setMemoryEntry(cacheKey, cacheEntry);
        applyCachedEntry(cacheEntry);

        void idbPutRender({
          hash: cacheKey,
          audioBlob: renderedWavBlob,
          blobSize: renderedWavBlob.size,
          notes: nextNotes,
          ticksPerQuarter: newTpQ,
          quartersPerBar: newQpB,
          tempoSegments,
          totalTicks,
          lastAccessed: Date.now(),
          createdAt: Date.now(),
        }).then(() => idbPruneLru());
      } finally {
        setIsProcessing(false);
      }
    },
    [
      applyCachedEntry,
      hashMidiBuffer,
      renderAudioOnClient,
      setMemoryEntry,
      touchMemoryEntry,
    ],
  );

  const handleFileUpload = (file?: File) => {
    if (!file) {
      return;
    }

    processMidiFile(file).catch((error) => {
      console.error("Failed to process uploaded MIDI file", error);
    });
  };

  useEffect(() => {
    if (!fileUrl || loadedFileUrlRef.current === fileUrl) {
      return;
    }

    loadedFileUrlRef.current = fileUrl;

    const loadFileFromUrl = async () => {
      const resolvedUrl = new URL(fileUrl, window.location.origin).toString();
      const response = await fetch(
        `/api/midi-proxy?file=${encodeURIComponent(resolvedUrl)}`,
      );
      if (!response.ok) {
        throw new Error(`Failed to fetch MIDI file: ${response.status}`);
      }

      const blob = await response.blob();
      const midiFile = new File([blob], "visualizer.mid", { type: blob.type });
      await processMidiFile(midiFile);
    };

    loadFileFromUrl().catch((error) => {
      console.error("Failed to load MIDI file from URL", error);
    });
  }, [fileUrl, processMidiFile]);

  useEffect(() => {
    const updateTime = () => {
      const audio = audioRef.current;
      if (audio) {
        positionRef.current = secondsToTicks(
          audio.currentTime,
          tempoSegmentsRef.current,
          totalTicksRef.current,
        );
      }
      animationFrameRef.current = window.requestAnimationFrame(updateTime);
    };

    animationFrameRef.current = window.requestAnimationFrame(updateTime);

    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      for (const pending of workerPendingRef.current.values()) {
        pending.reject(new Error("Visualizer worker terminated"));
      }
      workerPendingRef.current.clear();
      workerRef.current?.terminate();
      workerRef.current = null;

      for (const entry of memoryCacheRef.current.values()) {
        URL.revokeObjectURL(entry.audioUrl);
      }
      memoryCacheRef.current.clear();
    };
  }, []);

  return (
    <div>
      <main>
        {!fileUrl && (
          <div className="top-20 absolute flex justify-center items-center w-full">
            <label
              htmlFor="dropzone-file"
              className="flex flex-col justify-center items-center bg-gray-50 hover:bg-gray-100 dark:bg-gray-700 m-5 p-5 border-2 border-gray-300 dark:border-gray-600 dark:hover:border-gray-500 border-dashed rounded-2xl cursor-pointer"
            >
              <div className="flex flex-col justify-center items-center">
                <p className="mb-2 text-gray-500 dark:text-gray-400 text-sm">
                  Загрузить MIDI файл
                </p>
              </div>
              <input
                id="dropzone-file"
                type="file"
                className="hidden"
                onChange={(e) =>
                  handleFileUpload(
                    e.target.files ? e.target.files[0] : undefined,
                  )
                }
              />
            </label>
          </div>
        )}
        {isProcessing && (
          <div className="absolute inset-0 flex justify-center items-center bg-black bg-opacity-50">
            <div className="flex flex-col items-center">
              <div className="border-4 border-gray-300 border-t-transparent rounded-full w-12 h-12 animate-spin"></div>
              <p className="mt-4 text-white text-lg">Клиентский рендер аудио...</p>
            </div>
          </div>
        )}
        <div className="top-0 -z-30 absolute w-screen h-full">
          <PianoKeyboard
            timeStampRef={positionRef}
            notes={notes}
            width={resolution.x}
            height={resolution.y - 100}
            ticksPerBar={ticksPerQuarter * quartersPerBar}
            quartersPerBar={quartersPerBar}
          />
        </div>
        <div
          className="bottom-0 absolute flex flex-row justify-center items-center p-10 outline-none w-full"
          style={{ height: 100 }}
        >
          <audio
            src={audioFileURL}
            ref={audioRef}
            controls
            className="w-full visualizer-audio"
          />
        </div>
      </main>
    </div>
  );
}

export default function Visualizer() {
  return (
    <Suspense fallback={null}>
      <VisualizerContent />
    </Suspense>
  );
}
