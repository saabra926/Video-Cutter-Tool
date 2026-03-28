"use client";

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";

export type OutputFormat = "mp4" | "webm";
export type ExportProfile = "fast" | "balanced" | "quality";
export type TrimMode = "fast" | "exact";

type TrimStrategy = "stream-copy" | "transcode";
type SeekPlacement = "fast" | "accurate";

interface EngineStatus {
  progress?: number;
  message: string;
}

interface TrimRequest {
  file: File;
  startSec: number;
  endSec: number;
  outputFormat: OutputFormat;
  profile: ExportProfile;
  mode: TrimMode;
  includeAudio: boolean;
  signal?: AbortSignal;
  onStatus?: (status: EngineStatus) => void;
  onProgress?: (progress: number, seconds: number) => void;
}

interface TrimResult {
  blob: Blob;
  extension: OutputFormat;
  mimeType: string;
  elapsedMs: number;
  strategy: TrimStrategy;
}

const CORE_BASE_URL = "https://unpkg.com/@ffmpeg/core@0.12.9/dist/umd";
const EXEC_TIMEOUT_MS = -1;
const MAX_LOG_LINES = 12;
const MIME_BY_FORMAT: Record<OutputFormat, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
};
const STREAM_COPY_EXTENSIONS: Record<OutputFormat, string[]> = {
  mp4: ["mp4", "m4v", "mov"],
  webm: ["webm"],
};

let ffmpegInstance: FFmpeg | null = null;
let ffmpegLoadPromise: Promise<FFmpeg> | null = null;
let cachedCoreURLs: { coreURL: string; wasmURL: string } | null = null;

function getExtension(fileName: string): string {
  const match = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "mp4";
}

function getUniqueName(prefix: string, extension: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
}

function isAbortLikeError(error: unknown): boolean {
  if (error instanceof DOMException) return error.name === "AbortError";
  const message = error instanceof Error ? error.message : String(error);
  return /abort|cancel/i.test(message);
}

function summarizeLogLines(logLines: string[]): string | null {
  const normalized = logLines
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index, all) => index === all.findIndex((candidate) => candidate === line));

  if (!normalized.length) return null;
  return normalized.slice(-MAX_LOG_LINES).join(" | ");
}

function canUseStreamCopy(fileName: string, outputFormat: OutputFormat): boolean {
  return STREAM_COPY_EXTENSIONS[outputFormat].includes(getExtension(fileName));
}

function buildTrimBaseArgs({
  inputName,
  startSec,
  endSec,
  includeAudio,
  seekPlacement,
}: {
  inputName: string;
  startSec: number;
  endSec: number;
  includeAudio: boolean;
  seekPlacement: SeekPlacement;
}): string[] {
  const duration = Math.max(0.1, endSec - startSec);
  const seekArgs = seekPlacement === "fast" ? ["-ss", `${startSec}`, "-t", `${duration}`, "-i", inputName] : ["-i", inputName, "-ss", `${startSec}`, "-t", `${duration}`];

  return [
    "-hide_banner",
    "-loglevel",
    "error",
    ...seekArgs,
    "-map",
    "0:v:0",
    ...(includeAudio ? ["-map", "0:a?"] : ["-an"]),
  ];
}

function buildStreamCopyCommand({
  inputName,
  outputName,
  startSec,
  endSec,
  outputFormat,
  includeAudio,
}: {
  inputName: string;
  outputName: string;
  startSec: number;
  endSec: number;
  outputFormat: OutputFormat;
  includeAudio: boolean;
}): string[] {
  return [
    ...buildTrimBaseArgs({ inputName, startSec, endSec, includeAudio, seekPlacement: "fast" }),
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-sn",
    "-dn",
    "-c",
    "copy",
    "-copyinkf",
    ...(outputFormat === "mp4" ? ["-movflags", "+faststart", "-avoid_negative_ts", "make_zero"] : []),
    outputName,
  ];
}

function buildTrimCommand({
  inputName,
  outputName,
  startSec,
  endSec,
  outputFormat,
  profile,
  includeAudio,
  seekPlacement,
}: {
  inputName: string;
  outputName: string;
  startSec: number;
  endSec: number;
  outputFormat: OutputFormat;
  profile: ExportProfile;
  includeAudio: boolean;
  seekPlacement: SeekPlacement;
}): string[] {
  const baseArgs = buildTrimBaseArgs({ inputName, startSec, endSec, includeAudio, seekPlacement });

  if (outputFormat === "mp4") {
    const presetByProfile: Record<ExportProfile, string> = {
      fast: "ultrafast",
      balanced: "veryfast",
      quality: "medium",
    };
    const crfByProfile: Record<ExportProfile, string> = {
      fast: "30",
      balanced: "24",
      quality: "20",
    };

    return [
      ...baseArgs,
      "-c:v",
      "libx264",
      "-preset",
      presetByProfile[profile],
      "-crf",
      crfByProfile[profile],
      ...(includeAudio ? ["-c:a", "aac", "-b:a", profile === "quality" ? "160k" : profile === "balanced" ? "128k" : "96k"] : []),
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      "-threads",
      "0",
      outputName,
    ];
  }

  const crfByProfile: Record<ExportProfile, string> = {
    fast: "38",
    balanced: "32",
    quality: "28",
  };
  const cpuUsedByProfile: Record<ExportProfile, string> = {
    fast: "8",
    balanced: "4",
    quality: "1",
  };

  return [
    ...baseArgs,
    "-map_metadata",
    "0",
    "-map_chapters",
    "0",
    "-sn",
    "-dn",
    "-c:v",
    "libvpx-vp9",
    "-crf",
    crfByProfile[profile],
    "-b:v",
    "0",
    "-cpu-used",
    cpuUsedByProfile[profile],
    ...(includeAudio ? ["-c:a", "libopus", "-b:a", profile === "quality" ? "160k" : profile === "balanced" ? "128k" : "96k"] : []),
    "-threads",
    "0",
    outputName,
  ];
}

async function getCoreURLs(onStatus?: (status: EngineStatus) => void) {
  if (cachedCoreURLs) return cachedCoreURLs;

  onStatus?.({ progress: 0.02, message: "Downloading FFmpeg core" });
  const coreURL = await toBlobURL(
    `${CORE_BASE_URL}/ffmpeg-core.js`,
    "text/javascript",
    true,
    ({ total, received }) => {
      if (!total) return;
      onStatus?.({
        progress: Math.min(0.18, 0.02 + (received / total) * 0.16),
        message: "Downloading FFmpeg core",
      });
    }
  );

  const wasmURL = await toBlobURL(
    `${CORE_BASE_URL}/ffmpeg-core.wasm`,
    "application/wasm",
    true,
    ({ total, received }) => {
      if (!total) return;
      onStatus?.({
        progress: Math.min(0.38, 0.18 + (received / total) * 0.2),
        message: "Downloading FFmpeg wasm",
      });
    }
  );

  cachedCoreURLs = { coreURL, wasmURL };
  return cachedCoreURLs;
}

export async function ensureFfmpegLoaded(onStatus?: (status: EngineStatus) => void): Promise<FFmpeg> {
  if (ffmpegInstance?.loaded) return ffmpegInstance;
  if (ffmpegLoadPromise) return ffmpegLoadPromise;

  ffmpegLoadPromise = (async () => {
    const ffmpeg = ffmpegInstance ?? new FFmpeg();
    ffmpegInstance = ffmpeg;
    const urls = await getCoreURLs(onStatus);
    onStatus?.({ progress: 0.45, message: "Starting FFmpeg engine" });
    await ffmpeg.load(urls);
    onStatus?.({ progress: 0.5, message: "FFmpeg ready" });
    return ffmpeg;
  })();

  try {
    return await ffmpegLoadPromise;
  } finally {
    ffmpegLoadPromise = null;
  }
}

export async function trimVideoWithFfmpeg({
  file,
  startSec,
  endSec,
  outputFormat,
  profile,
  mode,
  includeAudio,
  signal,
  onStatus,
  onProgress,
}: TrimRequest): Promise<TrimResult> {
  const ffmpeg = await ensureFfmpegLoaded(onStatus);
  const inputName = getUniqueName("input", getExtension(file.name));
  const outputName = getUniqueName("output", outputFormat);
  const startedAt = performance.now();

  onStatus?.({ progress: 0.54, message: "Loading source video" });
  await ffmpeg.writeFile(inputName, await fetchFile(file), { signal });

  const progressHandler = ({ progress, time }: { progress: number; time: number }) => {
    onProgress?.(progress, time / 1_000_000);
  };

  let activeLogLines: string[] = [];
  const logHandler = ({ message }: { type: string; message: string }) => {
    const normalized = message.trim();
    if (!normalized) return;
    activeLogLines.push(normalized);
    if (activeLogLines.length > 50) activeLogLines.shift();
  };

  const readOutput = async (strategy: TrimStrategy): Promise<TrimResult> => {
    const fileData = await ffmpeg.readFile(outputName, "binary", { signal });
    const outputBytes = new Uint8Array(fileData as Uint8Array);
    const blob = new Blob([outputBytes.buffer], { type: MIME_BY_FORMAT[outputFormat] });

    return {
      blob,
      extension: outputFormat,
      mimeType: MIME_BY_FORMAT[outputFormat],
      elapsedMs: performance.now() - startedAt,
      strategy,
    };
  };

  const runCommand = async (args: string[], status: EngineStatus) => {
    activeLogLines = [];
    onStatus?.(status);
    const exitCode = await ffmpeg.exec(args, EXEC_TIMEOUT_MS, { signal });
    return {
      exitCode,
      details: summarizeLogLines(activeLogLines),
    };
  };

  ffmpeg.on("log", logHandler);
  ffmpeg.on("progress", progressHandler);

  let copyFailureDetails: string | null = null;

  try {
    if (mode === "fast" && canUseStreamCopy(file.name, outputFormat)) {
      const copyResult = await runCommand(
        buildStreamCopyCommand({
          inputName,
          outputName,
          startSec,
          endSec,
          outputFormat,
          includeAudio,
        }),
        { progress: 0.58, message: "Trying direct stream copy" }
      );

      if (copyResult.exitCode === 0) {
        onStatus?.({ progress: 0.94, message: "Finalizing copied clip" });
        return await readOutput("stream-copy");
      }

      copyFailureDetails = copyResult.details;
      onStatus?.({ progress: 0.62, message: "Direct copy unavailable, re-encoding" });
    }

    const transcodeResult = await runCommand(
      buildTrimCommand({
        inputName,
        outputName,
        startSec,
        endSec,
        outputFormat,
        profile,
        includeAudio,
        seekPlacement: mode === "exact" ? "accurate" : "fast",
      }),
      {
        progress: copyFailureDetails ? 0.64 : 0.58,
        message: mode === "exact" ? "Frame-accurate re-encoding" : "Re-encoding clip",
      }
    );

    if (transcodeResult.exitCode !== 0) {
      if (copyFailureDetails && transcodeResult.details) {
        throw new Error(`FFmpeg re-encode failed after direct copy retry: ${transcodeResult.details}. Direct copy error: ${copyFailureDetails}`);
      }

      const details = transcodeResult.details ?? copyFailureDetails;
      throw new Error(details ? `FFmpeg exited with code ${transcodeResult.exitCode}: ${details}` : `FFmpeg exited with code ${transcodeResult.exitCode}`);
    }

    return await readOutput("transcode");
  } catch (error) {
    if (isAbortLikeError(error)) throw error;

    const message = error instanceof Error ? error.message : String(error);
    const details = summarizeLogLines(activeLogLines);
    throw new Error(details && !message.includes(details) ? `${message}: ${details}` : message);
  } finally {
    ffmpeg.off("log", logHandler);
    ffmpeg.off("progress", progressHandler);
    try {
      await ffmpeg.deleteFile(inputName);
    } catch {
      // no-op
    }
    try {
      await ffmpeg.deleteFile(outputName);
    } catch {
      // no-op
    }
  }
}

