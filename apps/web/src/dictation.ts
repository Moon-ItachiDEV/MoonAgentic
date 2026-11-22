/** Dictation: the browser's own speech recognition, with the microphone's real level. */

/** The part of the Web Speech API the composer uses; not in TypeScript's DOM types yet. */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionClass;
    webkitSpeechRecognition?: RecognitionClass;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

/** True when this browser can turn speech into text (Chrome, Edge, Safari). */
export function dictationSupported(): boolean {
  // Over plain HTTP on the network, Chrome lists the API but refuses the microphone.
  return typeof window !== "undefined" && window.isSecureContext && !!recognitionClass();
}

/** On a phone, a second hold on the microphone can cut speech recognition: no level there. */
function levelSafe(): boolean {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  return !/Android|iPhone|iPad|Mobile/i.test(ua);
}

/** What was said so far: the sentences settled, then the words still being heard. */
export interface Heard {
  final: string;
  interim: string;
}

/** Puts the dictated words after what was already typed, with one space between. */
export function joinDictation(typed: string, heard: Heard): string {
  const said = `${heard.final} ${heard.interim}`.replace(/\s+/g, " ").trim();
  if (!said) return typed;
  if (!typed.trim()) return said;
  return /\s$/.test(typed) ? typed + said : `${typed} ${said}`;
}

/** Reads every result the recognizer holds, settled ones first. */
export function readResults(results: RecognitionEvent["results"]): Heard {
  // Some browsers start a new segment without a space: segments are joined with one.
  const final: string[] = [];
  const interim: string[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const said = r?.[0].transcript.trim();
    if (!r || !said) continue;
    (r.isFinal ? final : interim).push(said);
  }
  return { final: final.join(" "), interim: interim.join(" ") };
}

const ERRORS: Record<string, string> = {
  "not-allowed": "Le micro est refusé. Autorise-le pour cette page dans ton navigateur.",
  "service-not-allowed": "Le micro est refusé. Autorise-le pour cette page dans ton navigateur.",
  "audio-capture": "Aucun micro trouvé.",
  network: "La dictée a besoin d'internet : le navigateur fait la transcription en ligne.",
};

export interface Dictation {
  /** Ends listening and keeps what was heard. */
  stop(): void;
  /** Ends listening and drops what was heard. */
  cancel(): void;
}

/**
 * Starts listening. `onHeard` gets the whole text heard so far, `onLevel` the microphone's
 * loudness from 0 to 1 (when the browser lends the microphone twice), `onEnd` once it is over.
 */
export function startDictation(handlers: {
  onHeard: (heard: Heard) => void;
  onLevel: (level: number) => void;
  /** `heard` is the last text heard, read here so the last words before the end count. */
  onEnd: (kept: boolean, heard: Heard, error?: string) => void;
}): Dictation | undefined {
  const Class = recognitionClass();
  if (!Class) return undefined;
  const recognition = new Class();
  recognition.lang = navigator.language || "fr-FR";
  recognition.continuous = true;
  recognition.interimResults = true;

  let kept = true;
  let error: string | undefined;
  let ended = false;
  let stream: MediaStream | undefined;
  let audio: AudioContext | undefined;
  let frame = 0;
  let heard: Heard = { final: "", interim: "" };

  const release = () => {
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((t) => t.stop());
    void audio?.close().catch(() => undefined);
  };

  recognition.onresult = (event) => {
    heard = readResults(event.results);
    handlers.onHeard(heard);
  };
  recognition.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    error = ERRORS[event.error] ?? `La dictée s'est arrêtée (${event.error}).`;
  };
  recognition.onend = () => {
    if (ended) return;
    ended = true;
    release();
    handlers.onEnd(kept && !error, heard, error);
  };
  try {
    recognition.start();
  } catch {
    return undefined;
  }

  // The level only draws the waveform: dictation works without it.
  if (levelSafe())
    navigator.mediaDevices
      ?.getUserMedia({ audio: true })
      .then((s) => {
        if (ended) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        audio = new AudioContext();
        const analyser = audio.createAnalyser();
        analyser.fftSize = 512;
        audio.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const tick = () => {
          analyser.getByteTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += ((v - 128) / 128) ** 2;
          handlers.onLevel(Math.min(1, Math.sqrt(sum / data.length) * 4));
          frame = requestAnimationFrame(tick);
        };
        tick();
      })
      .catch(() => undefined);

  return {
    stop: () => recognition.stop(),
    cancel: () => {
      kept = false;
      recognition.abort();
    },
  };
}
