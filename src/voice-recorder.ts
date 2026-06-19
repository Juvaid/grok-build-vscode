// Impure side of voice input: spawn ffmpeg to capture the mic in the extension
// host (webviews can't reach the microphone), and POST the clip to xAI's
// Speech-to-Text API. The deterministic bits (arg building, device parsing,
// response/error handling) live in voice.ts and are unit-tested; this file is
// the thin spawn/fetch shell, smoke-tested manually via research/voice-stt-probe.cjs.
import { spawn, ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { Blob } from "node:buffer";
import {
  buildFfmpegArgs,
  buildListDevicesArgs,
  buildSttRequest,
  classifySttError,
  cleanTranscript,
  parseDshowAudioDevices,
  parseSttResponse,
} from "./voice";

export interface StartOpts {
  ffmpegPath: string;
  outputPath: string;
  device?: string;
  log?: (msg: string) => void;
}

/**
 * Resolve a DirectShow audio device name on Windows (dshow has no "default", so
 * a real device must be named). Returns the first audio device, or undefined.
 * Shared by the batch recorder and the streamer.
 */
export function resolveWindowsAudioDevice(ffmpegPath: string, log?: (m: string) => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stderr = "";
    let proc: ChildProcess;
    try {
      proc = spawn(ffmpegPath, buildListDevicesArgs(), { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(undefined);
      return;
    }
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", () => resolve(undefined));
    proc.on("exit", () => {
      const devices = parseDshowAudioDevices(stderr);
      log?.(`[voice] dshow audio devices: ${devices.join(" | ") || "(none)"}`);
      resolve(devices[0]);
    });
  });
}

/** List avfoundation audio devices on macOS. Returns the first usable audio device name/index. */
export function resolveMacAudioDevice(ffmpegPath: string, log?: (m: string) => void): Promise<string | undefined> {
  return new Promise((resolve) => {
    let stderr = "";
    let proc: ChildProcess;
    try {
      // -list_devices true -i "" will print devices to stderr and exit non-zero.
      proc = spawn(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], { stdio: ["ignore", "ignore", "pipe"] });
    } catch {
      resolve(undefined);
      return;
    }
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", () => resolve(undefined));
    proc.on("exit", () => {
      // Parse lines like: [0] Built-in Microphone or [1] External Mic
      const lines = stderr.split(/\r?\n/);
      const audioDevices: string[] = [];
      let inAudio = false;
      for (const line of lines) {
        if (/AVFoundation audio devices/i.test(line)) {
          inAudio = true;
          continue;
        }
        if (inAudio && /\[AVFoundation .*devices/i.test(line)) break;
        if (inAudio) {
          const m = line.match(/\[(\d+)\]\s*(.+)/);
          if (m) {
            const idx = m[1];
            const name = m[2].trim();
            audioDevices.push(idx); // prefer index for avfoundation
            audioDevices.push(name);
          }
        }
      }
      log?.(`[voice] avfoundation audio devices: ${audioDevices.join(" | ") || "(none)"}`);
      // Prefer first non-default if possible, else first.
      const preferred = audioDevices.find(d => !/default|built-in|internal/i.test(d)) || audioDevices[0];
      resolve(preferred ? (preferred.match(/^\d+$/) ? preferred : `:${preferred}`) : undefined);
    });
  });
}

/**
 * Records the microphone via an ffmpeg child process. Stop is graceful — we send
 * `q` on ffmpeg's stdin so it finalizes the WAV header (a hard kill would leave
 * a truncated, unreadable file) — with a SIGKILL fallback if it doesn't exit.
 */
export class VoiceRecorder {
  private proc?: ChildProcess;
  private outputPath?: string;

  get active(): boolean {
    return !!this.proc;
  }

  async start(opts: StartOpts): Promise<void> {
    if (this.proc) throw new Error("Already recording.");
    let device = opts.device;
    const plat = process.platform;
    if (!device) {
      if (plat === "win32") {
        device = await resolveWindowsAudioDevice(opts.ffmpegPath, opts.log);
        if (!device) {
          throw new Error(
            "No microphone (DirectShow audio device) was found. Plug one in, or set grok.voiceInputDevice to its name.",
          );
        }
      } else if (plat === "darwin") {
        device = await resolveMacAudioDevice(opts.ffmpegPath, opts.log);
        if (!device) {
          // fall back to default index 0
          device = ":0";
        }
      }
    }

    const args = buildFfmpegArgs(process.platform, { device, outputPath: opts.outputPath });
    opts.log?.(`[voice] record: ${opts.ffmpegPath} ${args.join(" ")}`);
    const proc = spawn(opts.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.outputPath = opts.outputPath;

    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      proc.on("error", (err: NodeJS.ErrnoException) => {
        this.proc = undefined;
        if (settled) return;
        settled = true;
        reject(
          err.code === "ENOENT"
            ? new Error("ffmpeg was not found. Install ffmpeg (https://ffmpeg.org) or set grok.ffmpegPath.")
            : err,
        );
      });
      proc.on("exit", (code) => {
        // A quick non-zero exit before we've stopped means capture failed to
        // start (bad device, permission, busy mic) — surface ffmpeg's reason.
        if (settled) return;
        settled = true;
        this.proc = undefined;
        reject(new Error(`ffmpeg exited (code ${code}) before recording started. ${stderr.slice(-300).trim()}`));
      });
      // No early failure within the grace window → treat as recording.
      setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve();
      }, 500);
    });
  }

  /** Stop recording and resolve with the finalized WAV path. */
  async stop(): Promise<string> {
    const proc = this.proc;
    const out = this.outputPath;
    this.proc = undefined;
    if (!proc || !out) throw new Error("Not recording.");
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      proc.on("exit", finish);
      try {
        proc.stdin?.write("q");
        proc.stdin?.end();
      } catch {
        /* fall through to the kill fallback */
      }
      setTimeout(() => {
        try { proc.kill("SIGKILL"); } catch { /* already gone */ }
        finish();
      }, 5000);
    });
    return out;
  }

  /** Abandon an in-flight recording without transcribing (e.g. on dispose). */
  cancel(): void {
    const proc = this.proc;
    this.proc = undefined;
    this.outputPath = undefined;
    if (!proc) return;
    try { proc.stdin?.write("q"); proc.stdin?.end(); } catch { /* ignore */ }
    try { proc.kill(); } catch { /* ignore */ }
  }

}

/**
 * POST a recorded WAV to the xAI Speech-to-Text API and return the transcript.
 * Throws a user-facing message on any failure (bad key, empty clip, HTTP error).
 */
export async function transcribeAudio(
  wavPath: string,
  apiKey: string,
  log?: (msg: string) => void,
): Promise<string> {
  const bytes = readFileSync(wavPath);
  // A valid WAV header alone is 44 bytes; anything this small captured no audio.
  if (bytes.length < 2048) {
    throw new Error("The recording was empty — no audio was captured. Check your microphone and try again.");
  }
  const { url, headers } = buildSttRequest({ key: apiKey });
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "audio/wav" }), "recording.wav");
  log?.(`[voice] POST ${url} (${bytes.length} bytes)`);
  const res = await fetch(url, { method: "POST", headers, body: form });
  const bodyText = await res.text();
  if (!res.ok) throw new Error(classifySttError(res.status, bodyText));
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    throw new Error("Voice transcription returned a non-JSON response.");
  }
  return cleanTranscript(parseSttResponse(json).text);
}
