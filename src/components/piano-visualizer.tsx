import React, { useEffect, useMemo, useRef } from "react";
import Color from "color";

const palette = ["#4B3DC8", "#BE8CCA", "#A9FFCB", "#E57A44", "#FB5012"].map(
  (s) => Color(s),
);

const DEFAULT_OCTAVE_COUNT = 8;
const DEFAULT_OCTAVE_START = 1;

const TIME_DELTA = 0.3;
const RENDER_BUCKET_TICKS = 480;

const BLACK_KEY_HEIGHT = 70;
const WHITE_KEY_HEIGHT = BLACK_KEY_HEIGHT * 2;
const NUM_WHITE_KEYS = 7;

const whiteKeys = [0, 2, 4, 5, 7, 9, 11];
const blackKeys = [1, 3, 6, 8, 10];
const BLACK_KEY_POSITIONS = [1, 2, 4, 5, 6];

type Note = {
  beginTime: number;
  endTime: number;
  midi: number;
  index: number;
};

type KeyInfo = {
  x: number;
  isWhite: boolean;
};

const keys: KeyInfo[] = [
  { x: 0, isWhite: true },
  { x: 2, isWhite: false },
  { x: 3, isWhite: true },
  { x: 5, isWhite: false },
  { x: 6, isWhite: true },
  { x: 9, isWhite: true },
  { x: 11, isWhite: false },
  { x: 12, isWhite: true },
  { x: 14, isWhite: false },
  { x: 15, isWhite: true },
  { x: 17, isWhite: false },
  { x: 18, isWhite: true },
];

type PianoKeyboardProps = {
  timeStamp?: number;
  timeStampRef?: React.MutableRefObject<number>;
  notes: Note[];
  width: number;
  height: number;
  ticksPerBar: number;
  quartersPerBar: number;
  octaveCount?: number;
  octaveStart?: number;
};

type RenderNote = {
  id: number;
  beginTime: number;
  endTime: number;
  midi: number;
  trackIndex: number;
  x: number;
  width: number;
  height: number;
};

type KeyRect = {
  midi: number;
  x: number;
  y: number;
  width: number;
  height: number;
  isWhite: boolean;
};

type RenderBuckets = {
  bucketSizeTicks: number;
  buckets: RenderNote[][];
};

function upperBound(values: RenderNote[], value: number, field: "beginTime" | "endTime") {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid][field] <= value) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function getTickFromProps(
  timeStamp?: number,
  timeStampRef?: React.MutableRefObject<number>,
): number {
  if (timeStampRef) {
    return timeStampRef.current;
  }

  return timeStamp ?? 0;
}

const PianoKeyboard: React.FC<PianoKeyboardProps> = ({
  timeStamp,
  timeStampRef,
  notes,
  width,
  height,
  ticksPerBar,
  quartersPerBar,
  octaveCount = DEFAULT_OCTAVE_COUNT,
  octaveStart = DEFAULT_OCTAVE_START,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const colorCache = useMemo(() => {
    return palette.map((color) => ({
      noteFill: color.hex(),
      noteStroke: color.darken(0.2).hex(),
      whiteFill: color.lighten(0.2).saturate(0.2).hex(),
      whiteStroke: color.darken(0.5).hex(),
      blackFill: color.darken(0.2).hex(),
      blackStroke: color.darken(0.5).hex(),
    }));
  }, []);

  const geometry = useMemo(() => {
    const dx = Math.max((width - 2) / (octaveCount * 7 * 3), 3);
    const whiteKeyWidth = 3 * dx;
    const blackKeyWidth = 2 * dx;

    const renderNotes: RenderNote[] = notes.map((note, id) => {
      const pitchClass = note.midi % 12;
      const key = keys[pitchClass];
      const octave = Math.floor(note.midi / 12);
      const x =
        key.x * dx +
        (octave - octaveStart) * NUM_WHITE_KEYS * whiteKeyWidth +
        2;
      const noteWidth = (key.isWhite ? whiteKeyWidth : blackKeyWidth) - 2;
      const noteHeight = (note.endTime - note.beginTime) * TIME_DELTA - 1;

      return {
        id,
        beginTime: note.beginTime,
        endTime: note.endTime,
        midi: note.midi,
        trackIndex: note.index,
        x,
        width: noteWidth,
        height: noteHeight,
      };
    });

    const starts = [...renderNotes].sort((a, b) => a.beginTime - b.beginTime);
    const ends = [...renderNotes].sort((a, b) => a.endTime - b.endTime);
    const byId = new Map<number, RenderNote>(renderNotes.map((note) => [note.id, note]));
    const maxEnd = renderNotes.length > 0 ? Math.max(...renderNotes.map((n) => n.endTime)) : 0;
    const bucketCount = Math.max(1, Math.ceil(maxEnd / RENDER_BUCKET_TICKS) + 2);
    const buckets: RenderNote[][] = Array.from({ length: bucketCount }, () => []);
    for (const note of renderNotes) {
      const startBucket = Math.max(0, Math.floor(note.beginTime / RENDER_BUCKET_TICKS));
      const endBucket = Math.max(startBucket, Math.floor(note.endTime / RENDER_BUCKET_TICKS));
      for (let bucket = startBucket; bucket <= endBucket; bucket += 1) {
        buckets[bucket].push(note);
      }
    }
    const renderBuckets: RenderBuckets = {
      bucketSizeTicks: RENDER_BUCKET_TICKS,
      buckets,
    };

    const keyRects: KeyRect[] = [];
    const keyboardY = height - WHITE_KEY_HEIGHT;

    for (let octaveIndex = 0; octaveIndex < octaveCount; octaveIndex += 1) {
      const octave = octaveStart + octaveIndex;
      const xBase = octaveIndex * NUM_WHITE_KEYS * whiteKeyWidth + 1;

      for (let i = 0; i < NUM_WHITE_KEYS; i += 1) {
        keyRects.push({
          midi: whiteKeys[i] + octave * 12,
          x: xBase + i * whiteKeyWidth,
          y: keyboardY,
          width: whiteKeyWidth,
          height: WHITE_KEY_HEIGHT,
          isWhite: true,
        });
      }

      for (let i = 0; i < BLACK_KEY_POSITIONS.length; i += 1) {
        keyRects.push({
          midi: blackKeys[i] + octave * 12,
          x: xBase + BLACK_KEY_POSITIONS[i] * whiteKeyWidth - dx,
          y: keyboardY,
          width: blackKeyWidth,
          height: BLACK_KEY_HEIGHT,
          isWhite: false,
        });
      }
    }

    return {
      dx,
      whiteKeyWidth,
      blackKeyWidth,
      starts,
      ends,
      byId,
      renderBuckets,
      keyRects,
    };
  }, [height, notes, octaveCount, octaveStart, width]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0 || height <= 0) {
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const whiteKeyboardLayer = document.createElement("canvas");
    whiteKeyboardLayer.width = canvas.width;
    whiteKeyboardLayer.height = canvas.height;
    const whiteKeyboardCtx = whiteKeyboardLayer.getContext("2d");
    if (!whiteKeyboardCtx) {
      return;
    }
    whiteKeyboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const blackKeyboardLayer = document.createElement("canvas");
    blackKeyboardLayer.width = canvas.width;
    blackKeyboardLayer.height = canvas.height;
    const blackKeyboardCtx = blackKeyboardLayer.getContext("2d");
    if (!blackKeyboardCtx) {
      return;
    }
    blackKeyboardCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const keyboardY = height - WHITE_KEY_HEIGHT;

    // Pre-render static keyboard and vertical guides.
    for (const key of geometry.keyRects.filter((k) => k.isWhite)) {
      whiteKeyboardCtx.fillStyle = "#ffffff";
      whiteKeyboardCtx.strokeStyle = "#1e293b";
      whiteKeyboardCtx.lineWidth = 1;
      whiteKeyboardCtx.beginPath();
      whiteKeyboardCtx.roundRect(key.x, key.y, key.width, key.height, 2);
      whiteKeyboardCtx.fill();
      whiteKeyboardCtx.stroke();
    }

    for (const key of geometry.keyRects.filter((k) => !k.isWhite)) {
      blackKeyboardCtx.fillStyle = "#000000";
      blackKeyboardCtx.strokeStyle = "#000000";
      blackKeyboardCtx.lineWidth = 1;
      blackKeyboardCtx.beginPath();
      blackKeyboardCtx.roundRect(key.x, key.y, key.width, key.height, 3);
      blackKeyboardCtx.fill();
      blackKeyboardCtx.stroke();
    }

    for (let octaveIndex = 0; octaveIndex < octaveCount; octaveIndex += 1) {
      const octaveX = octaveIndex * NUM_WHITE_KEYS * geometry.whiteKeyWidth;
      whiteKeyboardCtx.fillStyle = "#ffffff60";
      whiteKeyboardCtx.fillRect(octaveX, 0, 1, height);
      whiteKeyboardCtx.fillStyle = "#ffffff20";
      whiteKeyboardCtx.fillRect(octaveX + geometry.whiteKeyWidth * 3, 0, 1, height);
    }

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#000d");
    gradient.addColorStop(0.1, "#000d");
    gradient.addColorStop(0.5, "#0000");
    gradient.addColorStop(1, "#0000");

    let frame = 0;
    let prevTick = getTickFromProps(timeStamp, timeStampRef);
    let startPointer = upperBound(geometry.starts, prevTick, "beginTime");
    let endPointer = upperBound(geometry.ends, prevTick - 0.0001, "endTime");
    const activeByMidi = new Map<number, Set<number>>();

    const addActive = (note: RenderNote) => {
      if (!activeByMidi.has(note.midi)) {
        activeByMidi.set(note.midi, new Set<number>());
      }
      activeByMidi.get(note.midi)?.add(note.id);
    };

    const removeActive = (note: RenderNote) => {
      const ids = activeByMidi.get(note.midi);
      if (!ids) {
        return;
      }
      ids.delete(note.id);
      if (ids.size === 0) {
        activeByMidi.delete(note.midi);
      }
    };

    const rebuildActive = (tick: number) => {
      activeByMidi.clear();
      startPointer = upperBound(geometry.starts, tick, "beginTime");
      endPointer = upperBound(geometry.ends, tick - 0.0001, "endTime");

      for (let i = 0; i < startPointer; i += 1) {
        addActive(geometry.starts[i]);
      }
      for (let i = 0; i < endPointer; i += 1) {
        removeActive(geometry.ends[i]);
      }
    };

    rebuildActive(prevTick);

    const draw = () => {
      const tick = getTickFromProps(timeStamp, timeStampRef);
      const baseY = keyboardY + tick * TIME_DELTA;

      if (tick < prevTick) {
        rebuildActive(tick);
      } else {
        while (
          startPointer < geometry.starts.length &&
          geometry.starts[startPointer].beginTime <= tick
        ) {
          addActive(geometry.starts[startPointer]);
          startPointer += 1;
        }

        while (
          endPointer < geometry.ends.length &&
          geometry.ends[endPointer].endTime < tick
        ) {
          removeActive(geometry.ends[endPointer]);
          endPointer += 1;
        }
      }

      prevTick = tick;

      ctx.clearRect(0, 0, width, height);
      ctx.fillStyle = "#02040a";
      ctx.fillRect(0, 0, width, height);

      const minTick = Math.max(0, tick - ticksPerBar * 2);
      const maxTick = tick + height / TIME_DELTA + ticksPerBar * 2;
      const visibleStartBucket = Math.max(
        0,
        Math.floor(minTick / geometry.renderBuckets.bucketSizeTicks),
      );
      const visibleEndBucket = Math.max(
        visibleStartBucket,
        Math.floor(maxTick / geometry.renderBuckets.bucketSizeTicks),
      );
      const visibleIds = new Set<number>();

      const startBar = Math.max(0, Math.floor(minTick / ticksPerBar) - 1);
      const endBar = Math.ceil(maxTick / ticksPerBar) + 1;
      for (let bar = startBar; bar <= endBar; bar += 1) {
        const y = baseY - bar * ticksPerBar * TIME_DELTA;
        if (y < 0 || y > height) {
          continue;
        }

        ctx.fillStyle = (bar - 1) % quartersPerBar === 0 ? "#ffffff88" : "#ffffff22";
        ctx.fillRect(1, y, width - 2, 1);
      }

      for (let bucket = visibleStartBucket; bucket <= visibleEndBucket; bucket += 1) {
        const bucketNotes = geometry.renderBuckets.buckets[bucket];
        if (!bucketNotes || bucketNotes.length === 0) {
          continue;
        }

        for (const note of bucketNotes) {
          if (visibleIds.has(note.id)) {
            continue;
          }
          visibleIds.add(note.id);

          if (note.endTime < minTick || note.beginTime > maxTick) {
            continue;
          }

          const y = baseY - note.endTime * TIME_DELTA + 1;
          if (y > height || y + note.height < 0) {
            continue;
          }

          const trackPalette = colorCache[note.trackIndex % colorCache.length];
          ctx.fillStyle = trackPalette.noteFill;
          ctx.strokeStyle = trackPalette.noteStroke;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(note.x, y, note.width, note.height, 6);
          ctx.fill();
          ctx.stroke();
        }
      }

      // Correct piano layering: white keys first, black keys always on top.
      ctx.drawImage(whiteKeyboardLayer, 0, 0, width, height);

      for (const key of geometry.keyRects) {
        if (!key.isWhite) {
          continue;
        }
        const ids = activeByMidi.get(key.midi);
        if (!ids || ids.size === 0) {
          continue;
        }

        const noteId = ids.values().next().value;
        const note = noteId !== undefined ? geometry.byId.get(noteId) : undefined;
        if (!note) {
          continue;
        }

        const trackPalette = colorCache[note.trackIndex % colorCache.length];
        ctx.fillStyle = trackPalette.whiteFill;
        ctx.strokeStyle = trackPalette.whiteStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(key.x, key.y, key.width, key.height, 2);
        ctx.fill();
        ctx.stroke();
      }

      ctx.drawImage(blackKeyboardLayer, 0, 0, width, height);

      for (const key of geometry.keyRects) {
        if (key.isWhite) {
          continue;
        }
        const ids = activeByMidi.get(key.midi);
        if (!ids || ids.size === 0) {
          continue;
        }

        const noteId = ids.values().next().value;
        const note = noteId !== undefined ? geometry.byId.get(noteId) : undefined;
        if (!note) {
          continue;
        }

        const trackPalette = colorCache[note.trackIndex % colorCache.length];
        ctx.fillStyle = trackPalette.blackFill;
        ctx.strokeStyle = trackPalette.blackStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(key.x, key.y, key.width, key.height, 3);
        ctx.fill();
        ctx.stroke();
      }

      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      frame = window.requestAnimationFrame(draw);
    };

    frame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(frame);
  }, [
    colorCache,
    geometry,
    height,
    octaveCount,
    quartersPerBar,
    ticksPerBar,
    timeStamp,
    timeStampRef,
    width,
  ]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: `${width}px`,
        height: `${height}px`,
      }}
    />
  );
};

export default PianoKeyboard;
export type { Note };
