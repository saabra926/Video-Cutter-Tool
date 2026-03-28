"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ensureFfmpegLoaded, trimVideoWithFfmpeg, type TrimMode } from "@/lib/ffmpegClient";

interface VideoInfo {
  name: string;
  size: number;
  duration: number;
  url: string;
  file: File;
}

type OutputFormat = "mp4" | "webm";
type ExportProfile = "fast" | "balanced" | "quality";
type DragType = "start" | "end" | "seek";

interface ProfileConfig {
  label: string;
  description: string;
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  chunkMs: number;
}

interface RecorderPreset extends ProfileConfig {
  mimeType: string;
  extension: OutputFormat;
  fallbackFromRequested: boolean;
}

interface CutResult {
  blob: Blob;
  mimeType: string;
  extension: OutputFormat;
  elapsedMs: number;
  outputSeconds?: number;
  strategy?: "stream-copy" | "transcode" | "browser";
}

interface CutMeta {
  extension: OutputFormat;
  mimeType: string;
  elapsedMs: number;
  realtimeFactor: number;
  requestedFormat: OutputFormat;
  fallbackFromRequested: boolean;
  profile: ExportProfile;
  trimMode: TrimMode;
  includeAudio: boolean;
  engine: "ffmpeg" | "browser";
  strategy: "stream-copy" | "transcode" | "browser";
}

interface CutRequest {
  videoUrl: string;
  startSec: number;
  endSec: number;
  preset: RecorderPreset;
  includeAudio: boolean;
  onProgress: (percent: number, message: string) => void;
  signal?: AbortSignal;
}

const MIN_CLIP_SECONDS = 0.3;
const PREVIEW_END_EPSILON = 0.04;

const PROFILE_CONFIGS: Record<ExportProfile, ProfileConfig> = {
  fast: {
    label: "FAST",
    description: "Best speed, smaller output",
    videoBitsPerSecond: 4_500_000,
    audioBitsPerSecond: 96_000,
    chunkMs: 1200,
  },
  balanced: {
    label: "BALANCED",
    description: "Good quality and speed",
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 128_000,
    chunkMs: 900,
  },
  quality: {
    label: "QUALITY",
    description: "Highest quality, slower export",
    videoBitsPerSecond: 12_000_000,
    audioBitsPerSecond: 192_000,
    chunkMs: 600,
  },
};

const MIME_CANDIDATES: Record<OutputFormat, { withAudio: string[]; withoutAudio: string[] }> = {
  mp4: {
    withAudio: [
      "video/mp4;codecs=avc1.64001F,mp4a.40.2",
      "video/mp4;codecs=avc1.4d0028,mp4a.40.2",
      "video/mp4;codecs=h264,aac",
      "video/mp4",
    ],
    withoutAudio: ["video/mp4;codecs=avc1.64001F", "video/mp4;codecs=avc1.4d0028", "video/mp4;codecs=h264", "video/mp4"],
  },
  webm: {
    withAudio: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"],
    withoutAudio: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
  },
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeRange(start: number, end: number, duration: number): { start: number; end: number } {
  if (!Number.isFinite(duration) || duration <= 0) return { start: 0, end: 0 };
  if (duration <= MIN_CLIP_SECONDS) return { start: 0, end: duration };

  const maxStart = duration - MIN_CLIP_SECONDS;
  const safeStart = clamp(Number.isFinite(start) ? start : 0, 0, maxStart);
  const safeEnd = clamp(Number.isFinite(end) ? end : duration, safeStart + MIN_CLIP_SECONDS, duration);
  return { start: safeStart, end: safeEnd };
}

function formatTime(secondsInput: number): string {
  if (!Number.isFinite(secondsInput) || secondsInput < 0) return "00:00:00";
  const seconds = Math.floor(secondsInput);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function parseTime(input: string): number {
  const raw = input.trim();
  if (!raw) return NaN;
  const parts = raw.split(":");
  if (parts.length > 3) return NaN;

  const values = parts.map((part) => Number(part));
  if (values.some((value) => Number.isNaN(value) || value < 0)) return NaN;

  if (values.length === 1) return values[0];
  if (values.length === 2) return values[0] * 60 + values[1];
  return values[0] * 3600 + values[1] * 60 + values[2];
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortLikeError(error: unknown): boolean {
  return /abort|cancel/i.test(getErrorMessage(error));
}

function resolveRecorderPreset(requestedFormat: OutputFormat, profile: ExportProfile, includeAudio: boolean): RecorderPreset {
  const profileConfig = PROFILE_CONFIGS[profile];

  const supportsMime = (mime: string): boolean => {
    if (typeof window === "undefined") return false;
    if (typeof MediaRecorder === "undefined") return false;
    if (typeof MediaRecorder.isTypeSupported !== "function") return false;
    return MediaRecorder.isTypeSupported(mime);
  };

  const requestedMimes = MIME_CANDIDATES[requestedFormat][includeAudio ? "withAudio" : "withoutAudio"];
  const fallbackFormat: OutputFormat = requestedFormat === "mp4" ? "webm" : "mp4";
  const fallbackMimes = MIME_CANDIDATES[fallbackFormat][includeAudio ? "withAudio" : "withoutAudio"];

  const requestedMime = requestedMimes.find(supportsMime);
  if (requestedMime) {
    return {
      ...profileConfig,
      mimeType: requestedMime,
      extension: requestedFormat,
      fallbackFromRequested: false,
    };
  }

  const fallbackMime = fallbackMimes.find(supportsMime);
  if (fallbackMime) {
    return {
      ...profileConfig,
      mimeType: fallbackMime,
      extension: fallbackFormat,
      fallbackFromRequested: true,
    };
  }

  return {
    ...profileConfig,
    mimeType: includeAudio ? "video/webm;codecs=vp8,opus" : "video/webm;codecs=vp8",
    extension: "webm",
    fallbackFromRequested: requestedFormat !== "webm",
  };
}

async function seekVideo(video: HTMLVideoElement, targetSec: number): Promise<void> {
  const target = Math.max(0, targetSec);
  if (Math.abs(video.currentTime - target) < 0.01) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };

    const onSeeked = () => {
      video.removeEventListener("seeked", onSeeked);
      finish();
    };

    video.addEventListener("seeked", onSeeked, { once: true });
    video.currentTime = target;
    window.setTimeout(() => {
      video.removeEventListener("seeked", onSeeked);
      finish();
    }, 4500);
  });
}

async function cutVideoNative({ videoUrl, startSec, endSec, preset, includeAudio, onProgress, signal }: CutRequest): Promise<CutResult> {
  return new Promise((resolve, reject) => {
    const hiddenVideo = document.createElement("video");
    hiddenVideo.src = videoUrl;
    hiddenVideo.preload = "auto";
    hiddenVideo.playsInline = true;
    hiddenVideo.crossOrigin = "anonymous";
    hiddenVideo.muted = !includeAudio;
    hiddenVideo.volume = includeAudio ? 0.001 : 0;
    hiddenVideo.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;opacity:0;pointer-events:none;";
    document.body.appendChild(hiddenVideo);

    const clipDuration = Math.max(MIN_CLIP_SECONDS, endSec - startSec);
    const startedAt = performance.now();
    const chunks: BlobPart[] = [];

    let settled = false;
    let aborted = false;
    let recorder: MediaRecorder | null = null;
    let frameCallbackId: number | null = null;
    let intervalId: number | null = null;
    let watchdogId: number | null = null;
    let lastProgressStamp = 0;

    const cleanup = () => {
      if (frameCallbackId !== null && typeof (hiddenVideo as any).cancelVideoFrameCallback === "function") {
        try {
          (hiddenVideo as any).cancelVideoFrameCallback(frameCallbackId);
        } catch {
          // no-op
        }
      }
      if (intervalId !== null) window.clearInterval(intervalId);
      if (watchdogId !== null) window.clearTimeout(watchdogId);
      signal?.removeEventListener("abort", onAbort);

      try {
        hiddenVideo.pause();
        hiddenVideo.removeAttribute("src");
        hiddenVideo.load();
      } catch {
        // no-op
      }
      if (hiddenVideo.parentNode) hiddenVideo.parentNode.removeChild(hiddenVideo);
    };

    const finishReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    const finishResolve = (result: CutResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const stopRecorder = () => {
      if (!recorder) return;
      if (recorder.state === "recording" || recorder.state === "paused") recorder.stop();
    };

    const onAbort = () => {
      aborted = true;
      if (recorder) {
        stopRecorder();
      } else {
        finishReject(new Error("Processing cancelled by user."));
      }
    };

    if (signal?.aborted) {
      finishReject(new Error("Processing cancelled by user."));
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    hiddenVideo.addEventListener(
      "error",
      () => {
        finishReject(new Error("Could not load video for processing."));
      },
      { once: true }
    );

    hiddenVideo.addEventListener(
      "loadeddata",
      async () => {
        try {
          onProgress(6, "Preparing clip bounds");
          await seekVideo(hiddenVideo, startSec);

          onProgress(12, "Initializing capture stream");
          const captureStream: MediaStream | null =
            typeof (hiddenVideo as any).captureStream === "function"
              ? (hiddenVideo as any).captureStream()
              : typeof (hiddenVideo as any).mozCaptureStream === "function"
              ? (hiddenVideo as any).mozCaptureStream()
              : null;

          if (!captureStream) {
            finishReject(new Error("This browser does not support captureStream."));
            return;
          }

          if (!includeAudio) {
            for (const audioTrack of captureStream.getAudioTracks()) {
              captureStream.removeTrack(audioTrack);
              audioTrack.stop();
            }
          }

          const recorderOptions: MediaRecorderOptions = {
            mimeType: preset.mimeType,
            videoBitsPerSecond: preset.videoBitsPerSecond,
          };
          if (includeAudio) recorderOptions.audioBitsPerSecond = preset.audioBitsPerSecond;

          recorder = new MediaRecorder(captureStream, recorderOptions);
          recorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) chunks.push(event.data);
          };

          recorder.onerror = (event) => {
            finishReject(new Error(`MediaRecorder error: ${(event as any).error?.message ?? "unknown"}`));
          };

          recorder.onstop = () => {
            if (aborted) {
              finishReject(new Error("Processing cancelled by user."));
              return;
            }
            if (!chunks.length) {
              finishReject(new Error("No output data was produced."));
              return;
            }

            const resultBlob = new Blob(chunks, { type: preset.mimeType });
            finishResolve({
              blob: resultBlob,
              mimeType: preset.mimeType,
              extension: preset.extension,
              elapsedMs: performance.now() - startedAt,
              outputSeconds: clipDuration,
              strategy: "browser",
            });
          };

          recorder.start(preset.chunkMs);
          onProgress(22, `Recording started (${preset.label})`);

          if (includeAudio) {
            hiddenVideo.muted = false;
            hiddenVideo.volume = 0.001;
          }

          await hiddenVideo.play();
          onProgress(30, "Processing clip");

          const updateProgress = () => {
            if (settled || aborted) return;

            const current = hiddenVideo.currentTime;
            if (current >= endSec - 0.01 || hiddenVideo.ended) {
              onProgress(99, "Finalizing output");
              stopRecorder();
              return;
            }

            const now = performance.now();
            if (now - lastProgressStamp < 120) return;
            lastProgressStamp = now;

            const elapsed = Math.max(0, current - startSec);
            const percentage = Math.min(98, 30 + (elapsed / clipDuration) * 65);
            onProgress(Math.round(percentage), `Processing ${formatTime(current)}`);
          };

          if (typeof (hiddenVideo as any).requestVideoFrameCallback === "function") {
            const onFrame = () => {
              updateProgress();
              if (!settled && !aborted) {
                frameCallbackId = (hiddenVideo as any).requestVideoFrameCallback(onFrame);
              }
            };
            frameCallbackId = (hiddenVideo as any).requestVideoFrameCallback(onFrame);
          } else {
            intervalId = window.setInterval(updateProgress, 120);
          }

          watchdogId = window.setTimeout(() => {
            if (settled || aborted) return;
            onProgress(99, "Finalizing output");
            stopRecorder();
          }, (clipDuration + 8) * 1000);
        } catch (error) {
          finishReject(error);
        }
      },
      { once: true }
    );

    hiddenVideo.load();
  });
}

const HexBackground = () => (
  <div className="fixed inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 0 }}>
    <div className="absolute inset-0 bg-grid" />
    <div
      className="absolute inset-0"
      style={{ background: "radial-gradient(ellipse 80% 50% at 50% -10%, rgba(0,212,255,0.12) 0%, transparent 60%)" }}
    />
    <div
      className="absolute inset-0"
      style={{ background: "radial-gradient(ellipse 60% 40% at 80% 100%, rgba(57,255,20,0.04) 0%, transparent 50%)" }}
    />
  </div>
);

const Header = () => (
  <header className="relative z-10 border-b border-[#1a2535] bg-[#0a0e14]/80 backdrop-blur-md">
    <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="relative w-8 h-8">
          <div className="absolute inset-0 border-2 border-[#00d4ff] rotate-45 opacity-60" />
          <div className="absolute inset-1 border border-[#00d4ff] rotate-45" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="w-2 h-2 bg-[#00d4ff] rotate-45" />
          </div>
        </div>
        <div>
          <h1 className="font-display text-lg font-bold tracking-widest text-white" style={{ textShadow: "0 0 15px rgba(0,212,255,0.7)" }}>
            CUTFRAME
          </h1>
          <p className="text-[10px] font-mono text-[#6a7f95] tracking-[0.2em] uppercase">Precision Video Editor</p>
        </div>
      </div>
      <div className="hidden sm:flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-[#39ff14] animate-pulse" />
        <span className="font-mono text-xs text-[#39ff14]">BOUNDARY LOCK ACTIVE</span>
      </div>
    </div>
  </header>
);

const Footer = () => (
  <footer className="relative z-10 border-t border-[#1a2535] bg-[#030507]/90 mt-auto">
    <div className="max-w-6xl mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-3">
      <p className="font-mono text-xs text-[#6a7f95]">Browser-based, private, and production-ready clip cutting.</p>
      <p className="font-mono text-[10px] text-[#3a4a5c] tracking-widest uppercase">No Uploads. Your Files Stay Local.</p>
    </div>
  </footer>
);

const StatBadge = ({
  label,
  value,
  color = "accent",
}: {
  label: string;
  value: string;
  color?: "accent" | "neon" | "amber";
}) => {
  const classes = {
    accent: "text-[#00d4ff] border-[#00d4ff]/30 bg-[#00d4ff]/5",
    neon: "text-[#39ff14] border-[#39ff14]/30 bg-[#39ff14]/5",
    amber: "text-[#ffb700] border-[#ffb700]/30 bg-[#ffb700]/5",
  };

  return (
    <div className={`rounded border px-3 py-1.5 flex flex-col items-center gap-0.5 ${classes[color]}`}>
      <span className="font-mono text-[9px] tracking-widest uppercase opacity-60">{label}</span>
      <span className="font-mono text-sm font-semibold">{value}</span>
    </div>
  );
};

export default function VideoCutter() {
  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [startTime, setStartTime] = useState(0);
  const [endTime, setEndTime] = useState(0);
  const [startInput, setStartInput] = useState("00:00:00");
  const [endInput, setEndInput] = useState("00:00:00");
  const [isPlaying, setIsPlaying] = useState(false);

  const [requestedFormat, setRequestedFormat] = useState<OutputFormat>("mp4");
  const [exportProfile, setExportProfile] = useState<ExportProfile>("fast");
  const [trimMode, setTrimMode] = useState<TrimMode>("fast");
  const [includeAudio, setIncludeAudio] = useState(true);

  const [isCutting, setIsCutting] = useState(false);
  const [cutProgress, setCutProgress] = useState(0);
  const [cutStatus, setCutStatus] = useState("");
  const [cutDone, setCutDone] = useState(false);
  const [cutBlob, setCutBlob] = useState<Blob | null>(null);
  const [cutPreviewUrl, setCutPreviewUrl] = useState("");
  const [cutMeta, setCutMeta] = useState<CutMeta | null>(null);

  const [showShortcuts, setShowShortcuts] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [engineReady, setEngineReady] = useState(false);
  const [engineLoading, setEngineLoading] = useState(false);
  const [engineMessage, setEngineMessage] = useState("Engine cold");

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const dragTypeRef = useRef<DragType | null>(null);
  const uploadedVideoUrlRef = useRef<string | null>(null);
  const cutAbortRef = useRef<AbortController | null>(null);

  const clipDur = Math.max(0, endTime - startTime);
  const profileConfig = PROFILE_CONFIGS[exportProfile];

  const estimatedOutputSize = useMemo(() => {
    if (!video || clipDur <= 0) return "0 B";
    const bitsPerSecond = profileConfig.videoBitsPerSecond + (includeAudio ? profileConfig.audioBitsPerSecond : 0);
    return fmtSize((bitsPerSecond * clipDur) / 8);
  }, [video, clipDur, profileConfig, includeAudio]);

  useEffect(() => {
    if (!cutBlob) {
      setCutPreviewUrl("");
      return;
    }

    const url = URL.createObjectURL(cutBlob);
    setCutPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cutBlob]);

  useEffect(() => {
    return () => {
      cutAbortRef.current?.abort();
      if (uploadedVideoUrlRef.current) {
        URL.revokeObjectURL(uploadedVideoUrlRef.current);
        uploadedVideoUrlRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!video || engineReady || engineLoading) return;

    let cancelled = false;
    setEngineLoading(true);
    setEngineMessage("Preparing FFmpeg");

    void ensureFfmpegLoaded((status) => {
      if (cancelled) return;
      setEngineMessage(status.message);
    })
      .then(() => {
        if (cancelled) return;
        setEngineReady(true);
        setEngineMessage("FFmpeg ready");
      })
      .catch(() => {
        if (cancelled) return;
        setEngineMessage("FFmpeg will load on export");
      })
      .finally(() => {
        if (cancelled) return;
        setEngineLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [video, engineReady, engineLoading]);

  const resetCutState = useCallback(() => {
    setCutDone(false);
    setCutBlob(null);
    setCutMeta(null);
    setCutProgress(0);
    setCutStatus("");
  }, []);

  const handleFile = useCallback(
    (file: File) => {
      const looksLikeVideo = file.type.startsWith("video/") || /\.(mp4|mkv|mov|avi|webm)$/i.test(file.name);
      if (!looksLikeVideo) {
        setError("Please upload a valid video file.");
        return;
      }
      if (file.size > 4 * 1024 * 1024 * 1024) {
        setError("File too large. Maximum supported size is 4 GB.");
        return;
      }

      cutAbortRef.current?.abort();
      cutAbortRef.current = null;

      if (uploadedVideoUrlRef.current) {
        URL.revokeObjectURL(uploadedVideoUrlRef.current);
        uploadedVideoUrlRef.current = null;
      }

      setError(null);
      setIsCutting(false);
      setIsPlaying(false);
      resetCutState();

      const url = URL.createObjectURL(file);
      uploadedVideoUrlRef.current = url;

      const probe = document.createElement("video");
      probe.preload = "metadata";
      probe.src = url;

      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration) ? probe.duration : 0;
        if (duration <= 0) {
          if (uploadedVideoUrlRef.current === url) {
            URL.revokeObjectURL(url);
            uploadedVideoUrlRef.current = null;
          }
          setError("Could not read video metadata.");
          return;
        }

        const normalized = normalizeRange(0, duration, duration);
        setVideo({ name: file.name, size: file.size, duration, url, file });
        setCurrentTime(0);
        setStartTime(normalized.start);
        setEndTime(normalized.end);
        setStartInput(formatTime(normalized.start));
        setEndInput(formatTime(normalized.end));
      };

      probe.onerror = () => {
        if (uploadedVideoUrlRef.current === url) {
          URL.revokeObjectURL(url);
          uploadedVideoUrlRef.current = null;
        }
        setError("Could not open this video file.");
      };
    },
    [resetCutState]
  );

  const handleReset = useCallback(() => {
    cutAbortRef.current?.abort();
    cutAbortRef.current = null;

    if (uploadedVideoUrlRef.current) {
      URL.revokeObjectURL(uploadedVideoUrlRef.current);
      uploadedVideoUrlRef.current = null;
    }

    setVideo(null);
    setCurrentTime(0);
    setStartTime(0);
    setEndTime(0);
    setStartInput("00:00:00");
    setEndInput("00:00:00");
    setIsPlaying(false);
    setIsCutting(false);
    setError(null);
    resetCutState();

    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [resetCutState]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;

    const onTime = () => setCurrentTime(v.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onEnded = () => {
      setIsPlaying(false);
      v.currentTime = startTime;
    };

    v.addEventListener("timeupdate", onTime);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("ended", onEnded);

    return () => {
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("ended", onEnded);
    };
  }, [startTime, video?.url]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !isPlaying) return;

    if (currentTime >= endTime - PREVIEW_END_EPSILON) {
      v.pause();
      v.currentTime = startTime;
    }
  }, [currentTime, isPlaying, startTime, endTime]);

  useEffect(() => setStartInput(formatTime(startTime)), [startTime]);
  useEffect(() => setEndInput(formatTime(endTime)), [endTime]);

  const jumpBy = useCallback(
    (seconds: number) => {
      if (!videoRef.current || !video) return;
      videoRef.current.currentTime = clamp(videoRef.current.currentTime + seconds, 0, video.duration);
    },
    [video]
  );

  const setStartFromCurrent = useCallback(() => {
    if (!video) return;
    const next = normalizeRange(currentTime, endTime, video.duration);
    setStartTime(next.start);
    setEndTime(next.end);
    if (videoRef.current && videoRef.current.currentTime < next.start) {
      videoRef.current.currentTime = next.start;
    }
  }, [video, currentTime, endTime]);

  const setEndFromCurrent = useCallback(() => {
    if (!video) return;
    const next = normalizeRange(startTime, currentTime, video.duration);
    setStartTime(next.start);
    setEndTime(next.end);
  }, [video, currentTime, startTime]);

  const commitStartInput = useCallback(
    (rawValue: string) => {
      if (!video) return;
      const parsed = parseTime(rawValue);
      if (Number.isNaN(parsed)) {
        setStartInput(formatTime(startTime));
        return;
      }
      const next = normalizeRange(parsed, endTime, video.duration);
      setStartTime(next.start);
      setEndTime(next.end);
    },
    [video, startTime, endTime]
  );

  const commitEndInput = useCallback(
    (rawValue: string) => {
      if (!video) return;
      const parsed = parseTime(rawValue);
      if (Number.isNaN(parsed)) {
        setEndInput(formatTime(endTime));
        return;
      }
      const next = normalizeRange(startTime, parsed, video.duration);
      setStartTime(next.start);
      setEndTime(next.end);
    },
    [video, startTime, endTime]
  );

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;

    if (isPlaying) {
      v.pause();
      return;
    }

    if (v.currentTime < startTime || v.currentTime >= endTime - PREVIEW_END_EPSILON) {
      v.currentTime = startTime;
    }

    v.play().catch(() => {
      setError("Playback was blocked by browser autoplay policy. Click play again.");
    });
  }, [isPlaying, startTime, endTime]);

  const getTimeFromClientX = useCallback(
    (clientX: number) => {
      if (!timelineRef.current || !video) return 0;
      const rect = timelineRef.current.getBoundingClientRect();
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
      return ratio * video.duration;
    },
    [video]
  );

  const applyTimelineDrag = useCallback(
    (type: DragType, time: number) => {
      if (!video) return;
      const capped = clamp(time, 0, video.duration);

      if (type === "start") {
        const next = normalizeRange(capped, endTime, video.duration);
        setStartTime(next.start);
        setEndTime(next.end);
        if (videoRef.current) videoRef.current.currentTime = next.start;
        return;
      }

      if (type === "end") {
        const next = normalizeRange(startTime, capped, video.duration);
        setStartTime(next.start);
        setEndTime(next.end);
        return;
      }

      if (videoRef.current) videoRef.current.currentTime = capped;
    },
    [video, startTime, endTime]
  );

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!dragTypeRef.current) return;
      applyTimelineDrag(dragTypeRef.current, getTimeFromClientX(event.clientX));
    };

    const onPointerUp = () => {
      dragTypeRef.current = null;
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, [applyTimelineDrag, getTimeFromClientX]);

  useEffect(() => {
    if (!video) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;

      if (event.code === "Space") {
        event.preventDefault();
        togglePlay();
        return;
      }

      if (event.code === "KeyJ") {
        event.preventDefault();
        jumpBy(-5);
        return;
      }

      if (event.code === "KeyL") {
        event.preventDefault();
        jumpBy(5);
        return;
      }

      if (event.code === "KeyI") {
        event.preventDefault();
        setStartFromCurrent();
        return;
      }

      if (event.code === "KeyO") {
        event.preventDefault();
        setEndFromCurrent();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [video, togglePlay, jumpBy, setStartFromCurrent, setEndFromCurrent]);

  const handleCut = useCallback(async () => {
    if (!video || isCutting) return;

    const normalized = normalizeRange(startTime, endTime, video.duration);
    if (normalized.end - normalized.start < MIN_CLIP_SECONDS) {
      setError(`Clip must be at least ${MIN_CLIP_SECONDS.toFixed(1)} seconds.`);
      return;
    }

    const clipDuration = Math.max(MIN_CLIP_SECONDS, normalized.end - normalized.start);
    const finalizeCut = (result: CutResult, options: { fallbackFromRequested: boolean; engine: "ffmpeg" | "browser" }) => {
      const realtimeFactor = result.elapsedMs > 0 ? clipDuration / (result.elapsedMs / 1000) : 0;
      const strategy = result.strategy ?? (options.engine === "browser" ? "browser" : "transcode");

      setCutBlob(result.blob);
      setCutMeta({
        extension: result.extension,
        mimeType: result.mimeType,
        elapsedMs: result.elapsedMs,
        realtimeFactor,
        requestedFormat,
        fallbackFromRequested: options.fallbackFromRequested,
        profile: exportProfile,
        trimMode,
        includeAudio,
        engine: options.engine,
        strategy,
      });
      setCutProgress(100);
      setCutStatus(strategy === "stream-copy" ? "Done (fast copy)" : strategy === "browser" ? "Done (browser fallback)" : "Done");
      setCutDone(true);
    };

    setStartTime(normalized.start);
    setEndTime(normalized.end);

    setError(null);
    setIsCutting(true);
    setCutProgress(0);
    setCutStatus("Initializing export engine");
    setCutDone(false);
    setCutBlob(null);
    setCutMeta(null);

    if (videoRef.current) videoRef.current.pause();

    const abortController = new AbortController();
    cutAbortRef.current = abortController;

    try {
      try {
        const result = await trimVideoWithFfmpeg({
          file: video.file,
          startSec: normalized.start,
          endSec: normalized.end,
          outputFormat: requestedFormat,
          profile: exportProfile,
          mode: trimMode,
          includeAudio,
          signal: abortController.signal,
          onStatus: ({ progress, message }) => {
            if (typeof progress === "number") {
              setCutProgress(Math.min(55, Math.round(progress * 100)));
            }
            setCutStatus(message);
          },
          onProgress: (progress, seconds) => {
            const total = Math.min(98, 58 + progress * 40);
            setCutProgress(Math.round(total));
            setCutStatus(`Encoding ${formatTime(seconds)}`);
          },
        });

        finalizeCut(result, { fallbackFromRequested: false, engine: "ffmpeg" });
        setEngineReady(true);
        setEngineMessage(result.strategy === "stream-copy" ? "Fast stream copy used" : "FFmpeg ready");
      } catch (ffmpegError) {
        if (isAbortLikeError(ffmpegError)) throw ffmpegError;

        const preset = resolveRecorderPreset(requestedFormat, exportProfile, includeAudio);
        setCutProgress((current) => Math.max(current, 18));
        setCutStatus(`FFmpeg failed, retrying with browser ${preset.extension.toUpperCase()} export`);

        try {
          const result = await cutVideoNative({
            videoUrl: video.url,
            startSec: normalized.start,
            endSec: normalized.end,
            preset,
            includeAudio,
            signal: abortController.signal,
            onProgress: (percent, message) => {
              setCutProgress(Math.max(18, Math.round(percent)));
              setCutStatus(`Browser fallback: ${message}`);
            },
          });

          finalizeCut(result, {
            fallbackFromRequested: preset.fallbackFromRequested || result.extension !== requestedFormat,
            engine: "browser",
          });
          setEngineMessage("Browser fallback used");
        } catch (nativeError) {
          if (isAbortLikeError(nativeError)) throw nativeError;
          throw new Error(`FFmpeg failed: ${getErrorMessage(ffmpegError)}. Browser fallback failed: ${getErrorMessage(nativeError)}`);
        }
      }
    } catch (cutError) {
      const message = getErrorMessage(cutError);
      if (isAbortLikeError(cutError)) {
        setCutStatus("Export cancelled");
      } else {
        setError(`Cut failed: ${message}`);
      }
    } finally {
      cutAbortRef.current = null;
      setIsCutting(false);
    }
  }, [video, isCutting, startTime, endTime, requestedFormat, exportProfile, trimMode, includeAudio]);

  const cancelCut = useCallback(() => {
    if (!isCutting) return;
    cutAbortRef.current?.abort();
  }, [isCutting]);

  const handleDownload = useCallback(() => {
    if (!cutBlob || !video) return;

    const extension = cutMeta?.extension ?? "webm";
    const baseName = video.name.replace(/\.[^.]+$/, "");
    const downloadName = `${baseName}_${formatTime(startTime).replace(/:/g, "-")}_to_${formatTime(endTime).replace(/:/g, "-")}.${extension}`;
    const url = URL.createObjectURL(cutBlob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    window.setTimeout(() => URL.revokeObjectURL(url), 15000);
  }, [cutBlob, cutMeta, video, startTime, endTime]);

  const startPct = video ? (startTime / video.duration) * 100 : 0;
  const endPct = video ? (endTime / video.duration) * 100 : 0;
  const currentPct = video ? (currentTime / video.duration) * 100 : 0;

  const onTimelinePointerDown = (event: React.PointerEvent<HTMLDivElement>, type: DragType) => {
    event.preventDefault();
    dragTypeRef.current = type;
    applyTimelineDrag(type, getTimeFromClientX(event.clientX));
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#030507] relative">
      <HexBackground />
      <Header />

      <main className="flex-1 relative z-10 max-w-6xl mx-auto w-full px-4 sm:px-6 py-8 flex flex-col gap-6">
        {!video && (
          <div
            className={`relative corner-accent rounded-lg border-2 border-dashed transition-all duration-300 cursor-pointer ${
              isDragging ? "border-[#00d4ff] bg-[#00d4ff]/5" : "border-[#1a2535] bg-[#0a0e14]/60 hover:border-[#00d4ff]/50"
            }`}
            style={{ minHeight: 300 }}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              const file = event.dataTransfer.files[0];
              if (file) handleFile(file);
            }}
            onClick={() => fileInputRef.current?.click()}
          >
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-6 p-8 text-center">
              <div className="relative">
                <div
                  className="w-20 h-20 rounded-full border-2 border-[#00d4ff]/40 flex items-center justify-center"
                  style={{ boxShadow: "0 0 30px rgba(0,212,255,0.15)" }}
                >
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="17 8 12 3 7 8" />
                    <line x1="12" y1="3" x2="12" y2="15" />
                  </svg>
                </div>
                {isDragging && <div className="absolute inset-0 rounded-full border-2 border-[#00d4ff] animate-ping" />}
              </div>

              <div>
                <p className="font-display text-xl font-bold text-white tracking-wider mb-2">{isDragging ? "DROP VIDEO HERE" : "UPLOAD VIDEO"}</p>
                <p className="font-body text-sm text-[#6a7f95]">Drag and drop or click to browse</p>
                <p className="font-mono text-xs text-[#3a4a5c] mt-1 tracking-widest">MP4 MKV MOV AVI WEBM MAX 4 GB</p>
              </div>
            </div>
            <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => event.target.files?.[0] && handleFile(event.target.files[0])} />
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 bg-[#ff3c5a]/10 border border-[#ff3c5a]/30 rounded-lg px-4 py-3">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff3c5a" strokeWidth="2" className="flex-shrink-0 mt-0.5">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <p className="font-body text-sm text-[#ff3c5a]">{error}</p>
          </div>
        )}

        {!video && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {[
              { step: "01", title: "Upload", desc: "Drop your source file. Metadata is parsed locally." },
              { step: "02", title: "Trim", desc: "Set start and end with timeline, text input, or keyboard." },
              { step: "03", title: "Export", desc: "Choose format and speed profile, then download instantly." },
            ].map((card) => (
              <div key={card.step} className="glass-panel rounded-lg p-5 flex flex-col gap-3 corner-accent">
                <div className="flex items-start justify-between">
                  <span className="font-mono text-[#00d4ff] text-xs">STEP</span>
                  <span className="font-display text-3xl font-black text-[#1a2535]">{card.step}</span>
                </div>
                <div>
                  <p className="font-display text-sm font-bold text-white tracking-wider mb-1">{card.title}</p>
                  <p className="font-body text-xs text-[#6a7f95] leading-relaxed">{card.desc}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {video && (
          <div className="flex flex-col gap-5">
            <div className="glass-panel rounded-lg px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded bg-[#00d4ff]/10 border border-[#00d4ff]/20 flex items-center justify-center flex-shrink-0">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#00d4ff" strokeWidth="2">
                    <polygon points="23 7 16 12 23 17 23 7" />
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                  </svg>
                </div>
                <div>
                  <p className="font-body text-sm text-white font-medium truncate max-w-[180px] sm:max-w-xs">{video.name}</p>
                  <p className="font-mono text-[10px] text-[#6a7f95]">{fmtSize(video.size)}</p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                <StatBadge label="Duration" value={formatTime(video.duration)} color="accent" />
                <StatBadge label="Clip" value={formatTime(clipDur)} color="neon" />
                <StatBadge label="Est. Size" value={estimatedOutputSize} color="amber" />
                <button
                  onClick={handleReset}
                  className="w-8 h-8 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#ff3c5a] hover:border-[#ff3c5a]/40 transition-colors flex items-center justify-center"
                  title="Reset"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18" />
                    <line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
              <div className="lg:col-span-3 flex flex-col gap-3">
                <div className="corner-accent rounded-lg overflow-hidden relative bg-black" style={{ boxShadow: "0 0 40px rgba(0,0,0,0.8)" }}>
                  <div className="scanlines relative">
                    <video ref={videoRef} src={video.url} className="w-full aspect-video object-contain" preload="metadata" playsInline />
                  </div>
                  <div className="absolute top-3 right-3 bg-black/70 backdrop-blur-sm border border-[#1a2535] rounded px-2 py-1">
                    <span className="font-mono text-xs text-[#00d4ff]">{formatTime(currentTime)}</span>
                  </div>
                </div>

                <div className="glass-panel rounded-lg px-4 py-3 flex items-center gap-2">
                  <button
                    onClick={() => jumpBy(-10)}
                    title="Back 10 seconds"
                    className="relative w-9 h-9 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#00d4ff] hover:border-[#00d4ff]/40 transition-all flex flex-col items-center justify-center gap-0"
                  >
                    <span className="font-mono text-[10px]">-10</span>
                  </button>

                  <button
                    onClick={() => jumpBy(-5)}
                    title="Back 5 seconds"
                    className="relative w-9 h-9 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#00d4ff] hover:border-[#00d4ff]/40 transition-all flex flex-col items-center justify-center gap-0"
                  >
                    <span className="font-mono text-[10px]">-5</span>
                  </button>

                  <button
                    onClick={togglePlay}
                    className="w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0"
                    style={{
                      background: isPlaying ? "rgba(255,60,90,0.15)" : "rgba(0,212,255,0.15)",
                      border: `1px solid ${isPlaying ? "rgba(255,60,90,0.5)" : "rgba(0,212,255,0.5)"}`,
                    }}
                    title="Play or pause"
                  >
                    {isPlaying ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[#ff3c5a]">
                        <rect x="6" y="4" width="4" height="16" />
                        <rect x="14" y="4" width="4" height="16" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-[#00d4ff] ml-0.5">
                        <polygon points="5 3 19 12 5 21 5 3" />
                      </svg>
                    )}
                  </button>

                  <button
                    onClick={() => jumpBy(5)}
                    title="Forward 5 seconds"
                    className="relative w-9 h-9 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#00d4ff] hover:border-[#00d4ff]/40 transition-all flex flex-col items-center justify-center gap-0"
                  >
                    <span className="font-mono text-[10px]">+5</span>
                  </button>

                  <button
                    onClick={() => jumpBy(10)}
                    title="Forward 10 seconds"
                    className="relative w-9 h-9 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#00d4ff] hover:border-[#00d4ff]/40 transition-all flex flex-col items-center justify-center gap-0"
                  >
                    <span className="font-mono text-[10px]">+10</span>
                  </button>

                  <div
                    className="flex-1 relative h-2 bg-[#1a2535] rounded-full cursor-pointer"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      if (!videoRef.current) return;
                      const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
                      videoRef.current.currentTime = ratio * video.duration;
                    }}
                  >
                    <div className="absolute h-full bg-[#00d4ff]/40 rounded-full" style={{ width: `${currentPct}%` }} />
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-[#00d4ff] border-2 border-[#030507] -translate-x-1/2"
                      style={{ left: `${currentPct}%`, boxShadow: "0 0 6px rgba(0,212,255,0.8)" }}
                    />
                  </div>

                  <button
                    onClick={() => {
                      if (!videoRef.current) return;
                      videoRef.current.currentTime = startTime;
                      void videoRef.current.play();
                    }}
                    className="px-3 py-1 rounded border border-[#39ff14]/30 text-[#39ff14] font-mono text-xs hover:bg-[#39ff14]/10 transition-colors whitespace-nowrap"
                  >
                    PREVIEW
                  </button>
                </div>
              </div>

              <div className="lg:col-span-2 flex flex-col gap-4">
                <div className="glass-panel rounded-lg p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-1 h-4 bg-[#00d4ff] rounded-full" />
                    <p className="font-display text-xs font-semibold text-white tracking-widest uppercase">Clip Timespan</p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="font-mono text-[10px] text-[#6a7f95] tracking-widest uppercase">Start Time</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={startInput}
                        onChange={(event) => setStartInput(event.target.value)}
                        onBlur={(event) => commitStartInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitStartInput((event.target as HTMLInputElement).value);
                        }}
                        placeholder="HH:MM:SS"
                        className="flex-1 bg-[#0a0e14] border border-[#1a2535] focus:border-[#00d4ff] text-[#00d4ff] font-mono text-sm rounded px-3 py-2 outline-none transition-colors"
                      />
                      <button
                        onClick={setStartFromCurrent}
                        className="px-3 py-2 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#00d4ff] hover:border-[#00d4ff]/40 font-mono text-xs transition-all whitespace-nowrap"
                      >
                        SET NOW
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="font-mono text-[10px] text-[#6a7f95] tracking-widest uppercase">End Time</label>
                    <div className="flex gap-2 items-center">
                      <input
                        type="text"
                        value={endInput}
                        onChange={(event) => setEndInput(event.target.value)}
                        onBlur={(event) => commitEndInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") commitEndInput((event.target as HTMLInputElement).value);
                        }}
                        placeholder="HH:MM:SS"
                        className="flex-1 bg-[#0a0e14] border border-[#1a2535] focus:border-[#39ff14] text-[#39ff14] font-mono text-sm rounded px-3 py-2 outline-none transition-colors"
                      />
                      <button
                        onClick={setEndFromCurrent}
                        className="px-3 py-2 rounded border border-[#1a2535] text-[#6a7f95] hover:text-[#39ff14] hover:border-[#39ff14]/40 font-mono text-xs transition-all whitespace-nowrap"
                      >
                        SET NOW
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5">
                    {[
                      { label: "First 30s", s: 0, e: Math.min(30, video.duration) },
                      { label: "First 1m", s: 0, e: Math.min(60, video.duration) },
                      { label: "Last 30s", s: Math.max(0, video.duration - 30), e: video.duration },
                    ].map((quick) => (
                      <button
                        key={quick.label}
                        onClick={() => {
                          const next = normalizeRange(quick.s, quick.e, video.duration);
                          setStartTime(next.start);
                          setEndTime(next.end);
                        }}
                        className="py-1.5 rounded border border-[#1a2535] text-[#6a7f95] hover:text-white hover:border-[#00d4ff]/30 font-mono text-[10px] transition-all hover:bg-[#00d4ff]/5"
                      >
                        {quick.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center justify-between bg-[#0a0e14] rounded border border-[#1a2535] px-3 py-2">
                    <span className="font-mono text-[10px] text-[#6a7f95] tracking-widest">CLIP DURATION</span>
                    <span className="font-mono text-sm font-bold text-[#ffb700]" style={{ textShadow: "0 0 8px rgba(255,183,0,0.5)" }}>
                      {formatTime(clipDur)}
                    </span>
                  </div>
                </div>

                <div className="glass-panel rounded-lg p-4 flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <div className="w-1 h-4 bg-[#39ff14] rounded-full" />
                    <p className="font-display text-xs font-semibold text-white tracking-widest uppercase">Export Settings</p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="font-mono text-[10px] text-[#6a7f95] tracking-widest uppercase">Output Format</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {(["mp4", "webm"] as OutputFormat[]).map((format) => (
                        <button
                          key={format}
                          onClick={() => setRequestedFormat(format)}
                          className={`py-1.5 rounded border font-mono text-[10px] transition-all ${
                            requestedFormat === format
                              ? "border-[#00d4ff]/70 text-[#00d4ff] bg-[#00d4ff]/10"
                              : "border-[#1a2535] text-[#6a7f95] hover:text-white hover:border-[#00d4ff]/30"
                          }`}
                        >
                          {format.toUpperCase()}
                        </button>
                      ))}
                    </div>
                    <p className="font-mono text-[10px] text-[#3a4a5c]">MP4 is fastest in Fast mode and can use direct copy on compatible MP4/MOV sources. WEBM usually needs a slower re-encode.</p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="font-mono text-[10px] text-[#6a7f95] tracking-widest uppercase">Trim Mode</label>
                    <div className="grid grid-cols-2 gap-1.5">
                      {([
                        { value: "fast", label: "FAST", description: "Uses direct copy when possible for maximum speed and original quality." },
                        { value: "exact", label: "EXACT", description: "Forces frame-accurate trimming with re-encoding for more precise cut points." },
                      ] as const).map((modeOption) => (
                        <button
                          key={modeOption.value}
                          onClick={() => setTrimMode(modeOption.value)}
                          className={`py-1.5 rounded border font-mono text-[10px] transition-all ${
                            trimMode === modeOption.value
                              ? "border-[#ffb700]/70 text-[#ffb700] bg-[#ffb700]/10"
                              : "border-[#1a2535] text-[#6a7f95] hover:text-white hover:border-[#ffb700]/30"
                          }`}
                        >
                          {modeOption.label}
                        </button>
                      ))}
                    </div>
                    <p className="font-mono text-[10px] text-[#3a4a5c]">
                      {trimMode === "fast"
                        ? "Fast is best when you want shorter processing time. On compatible files it copies the original streams instead of re-encoding."
                        : "Exact is slower, but it avoids keyframe-only trimming and gives more precise start/end timing."}
                    </p>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="font-mono text-[10px] text-[#6a7f95] tracking-widest uppercase">Speed / Quality</label>
                    <div className="grid grid-cols-3 gap-1.5">
                      {(["fast", "balanced", "quality"] as ExportProfile[]).map((profile) => (
                        <button
                          key={profile}
                          onClick={() => setExportProfile(profile)}
                          className={`py-1.5 rounded border font-mono text-[10px] transition-all ${
                            exportProfile === profile
                              ? "border-[#39ff14]/70 text-[#39ff14] bg-[#39ff14]/10"
                              : "border-[#1a2535] text-[#6a7f95] hover:text-white hover:border-[#39ff14]/30"
                          }`}
                        >
                          {PROFILE_CONFIGS[profile].label}
                        </button>
                      ))}
                    </div>
                    <p className="font-mono text-[10px] text-[#3a4a5c]">{profileConfig.description}</p>
                  </div>

                  <label className="flex items-center justify-between bg-[#0a0e14] rounded border border-[#1a2535] px-3 py-2 cursor-pointer">
                    <span className="font-mono text-[10px] text-[#6a7f95] tracking-widest">INCLUDE AUDIO</span>
                    <input type="checkbox" checked={includeAudio} onChange={() => setIncludeAudio((prev) => !prev)} className="h-4 w-4 accent-[#39ff14]" />
                  </label>

                  <button
                    onClick={() => setShowShortcuts((prev) => !prev)}
                    className="py-1.5 rounded border border-[#1a2535] text-[#6a7f95] hover:text-white hover:border-[#00d4ff]/30 font-mono text-[10px] transition-all"
                  >
                    {showShortcuts ? "HIDE SHORTCUTS" : "SHOW SHORTCUTS"}
                  </button>

                  {showShortcuts && (
                    <p className="font-mono text-[10px] text-[#3a4a5c] leading-relaxed">
                      Space: Play/Pause | J/L: -5s/+5s | I: Set start | O: Set end
                    </p>
                  )}

                  <div className="flex items-center justify-between bg-[#0a0e14] rounded border border-[#1a2535] px-3 py-2">
                    <span className="font-mono text-[10px] text-[#6a7f95] tracking-widest">ENGINE</span>
                    <span className={`font-mono text-[10px] ${engineReady ? "text-[#39ff14]" : engineLoading ? "text-[#ffb700]" : "text-[#6a7f95]"}`}>
                      {engineMessage}
                    </span>
                  </div>
                </div>

                {!cutDone && (
                  <div className="flex flex-col gap-3">
                    <button
                      onClick={handleCut}
                      disabled={isCutting || clipDur <= 0}
                      className="relative rounded-lg font-display text-sm font-bold tracking-widest uppercase py-4 transition-all overflow-hidden disabled:opacity-40 disabled:cursor-not-allowed"
                      style={{
                        background: isCutting ? "rgba(0,212,255,0.05)" : "linear-gradient(135deg,rgba(0,212,255,0.15),rgba(0,153,187,0.1))",
                        border: "1px solid rgba(0,212,255,0.5)",
                        boxShadow: isCutting ? "none" : "0 0 25px rgba(0,212,255,0.2)",
                        color: "#00d4ff",
                      }}
                    >
                      {isCutting ? (
                        <span className="flex flex-col items-center gap-1.5 px-2">
                          <span className="flex items-center gap-2">
                            <svg className="animate-spin flex-shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                            <span className="truncate">
                              {cutProgress}% - {cutStatus}
                            </span>
                          </span>
                        </span>
                      ) : (
                        <span className="flex items-center justify-center gap-2">CUT CLIP</span>
                      )}
                      {isCutting && <div className="absolute bottom-0 left-0 h-1 bg-[#00d4ff] transition-all duration-300" style={{ width: `${cutProgress}%` }} />}
                    </button>

                    {isCutting && (
                      <button
                        onClick={cancelCut}
                        className="rounded border border-[#ff3c5a]/40 text-[#ff3c5a] hover:text-white hover:bg-[#ff3c5a]/10 font-mono text-xs py-2 transition-colors"
                      >
                        CANCEL EXPORT
                      </button>
                    )}
                  </div>
                )}

                {cutDone && cutBlob && (
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2 bg-[#39ff14]/10 border border-[#39ff14]/30 rounded-lg px-3 py-2">
                      <div className="w-2 h-2 rounded-full bg-[#39ff14] flex-shrink-0" />
                      <p className="font-mono text-xs text-[#39ff14]">Clip ready: {fmtSize(cutBlob.size)}</p>
                    </div>

                    {cutMeta && (
                      <div className="bg-[#0a0e14] border border-[#1a2535] rounded-lg px-3 py-2 flex flex-col gap-1">
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          ENGINE: <span className="text-[#39ff14]">{cutMeta.engine === "ffmpeg" ? "FFMPEG WASM" : "BROWSER CAPTURE FALLBACK"}</span>
                        </p>
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          TRIM MODE: <span className="text-[#ffb700]">{cutMeta.trimMode.toUpperCase()}</span>
                        </p>
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          MODE: <span className="text-[#00d4ff]">{cutMeta.strategy === "stream-copy" ? "DIRECT STREAM COPY" : cutMeta.strategy === "browser" ? "BROWSER CAPTURE" : "RE-ENCODE"}</span>
                        </p>
                        {cutMeta.fallbackFromRequested && (
                          <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                            REQUESTED: <span className="text-[#ffb700]">{cutMeta.requestedFormat.toUpperCase()}</span> {"->"} DELIVERED: <span className="text-[#00d4ff]">{cutMeta.extension.toUpperCase()}</span>
                          </p>
                        )}
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          FORMAT: <span className="text-[#00d4ff]">{cutMeta.extension.toUpperCase()}</span> ({cutMeta.mimeType})
                        </p>
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          SPEED: <span className="text-[#39ff14]">{cutMeta.realtimeFactor.toFixed(2)}x realtime</span> | PROFILE: {PROFILE_CONFIGS[cutMeta.profile].label}
                        </p>
                        <p className="font-mono text-[10px] text-[#6a7f95] tracking-widest">
                          ENCODE TIME: <span className="text-[#ffb700]">{(cutMeta.elapsedMs / 1000).toFixed(2)}s</span>
                        </p>
                      </div>
                    )}

                    <button
                      onClick={handleDownload}
                      className="rounded-lg font-display text-sm font-bold tracking-widest uppercase py-4 transition-all"
                      style={{
                        background: "linear-gradient(135deg,rgba(57,255,20,0.15),rgba(30,200,10,0.1))",
                        border: "1px solid rgba(57,255,20,0.5)",
                        boxShadow: "0 0 25px rgba(57,255,20,0.2)",
                        color: "#39ff14",
                      }}
                    >
                      DOWNLOAD {cutMeta?.extension.toUpperCase() ?? "FILE"}
                    </button>

                    {cutPreviewUrl && (
                      <div className="rounded-lg overflow-hidden border border-[#1a2535] bg-black">
                        <p className="font-mono text-[10px] text-[#6a7f95] px-3 pt-2 pb-1 tracking-widest">PREVIEW RESULT</p>
                        <video src={cutPreviewUrl} controls preload="metadata" className="w-full" style={{ maxHeight: 180 }} />
                      </div>
                    )}

                    <button
                      onClick={resetCutState}
                      className="rounded border border-[#1a2535] text-[#6a7f95] hover:text-white font-mono text-xs py-2 transition-colors"
                    >
                      CUT ANOTHER CLIP
                    </button>
                  </div>
                )}
              </div>
            </div>

            <div className="glass-panel rounded-lg p-4 flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-1 h-4 bg-[#ffb700] rounded-full" />
                  <p className="font-display text-xs font-semibold text-white tracking-widest uppercase">Timeline</p>
                </div>
                <span className="font-mono text-[10px] text-[#3a4a5c]">
                  {formatTime(startTime)} {"->"} {formatTime(endTime)}
                </span>
              </div>

              <div className="relative" style={{ height: 56 }}>
                <div
                  ref={timelineRef}
                  className="absolute inset-x-0 top-4 h-8 rounded cursor-pointer select-none"
                  style={{ background: "#0a0e14", border: "1px solid #1a2535" }}
                  onPointerDown={(event) => onTimelinePointerDown(event, "seek")}
                >
                  <div
                    className="absolute inset-0 rounded overflow-hidden"
                    style={{
                      background: "repeating-linear-gradient(90deg,rgba(255,255,255,0.02) 0,rgba(255,255,255,0.02) 1px,transparent 1px,transparent 20px)",
                    }}
                  />

                  <div
                    className="absolute top-0 bottom-0 rounded"
                    style={{
                      left: `${startPct}%`,
                      width: `${Math.max(0, endPct - startPct)}%`,
                      background: "linear-gradient(135deg,rgba(0,212,255,0.2),rgba(57,255,20,0.1))",
                      border: "1px solid rgba(0,212,255,0.4)",
                    }}
                  />

                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-white/80 pointer-events-none"
                    style={{ left: `${currentPct}%`, boxShadow: "0 0 6px rgba(255,255,255,0.6)", zIndex: 10 }}
                  />

                  <div
                    className="clip-handle absolute top-0 bottom-0 w-3 -translate-x-1/2 z-20"
                    style={{ left: `${startPct}%` }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onTimelinePointerDown(event, "start");
                    }}
                  >
                    <div className="w-3 h-full rounded-sm" style={{ background: "#00d4ff", boxShadow: "0 0 8px rgba(0,212,255,0.8)" }} />
                  </div>

                  <div
                    className="clip-handle absolute top-0 bottom-0 w-3 -translate-x-1/2 z-20"
                    style={{ left: `${endPct}%` }}
                    onPointerDown={(event) => {
                      event.stopPropagation();
                      onTimelinePointerDown(event, "end");
                    }}
                  >
                    <div className="w-3 h-full rounded-sm" style={{ background: "#39ff14", boxShadow: "0 0 8px rgba(57,255,20,0.8)" }} />
                  </div>
                </div>

                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between px-1">
                  {Array.from({ length: 9 }).map((_, index) => (
                    <span key={index} className="font-mono text-[9px] text-[#3a4a5c]">
                      {formatTime((video.duration / 8) * index)}
                    </span>
                  ))}
                </div>
              </div>

              <p className="font-mono text-[10px] text-[#3a4a5c] text-center">
                Drag cyan for start, green for end, and click timeline to seek. Playback auto-stops at end marker.
              </p>
            </div>
          </div>
        )}
      </main>

      <Footer />
    </div>
  );
}




