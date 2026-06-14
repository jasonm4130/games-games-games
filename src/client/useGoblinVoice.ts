import { useCallback, useEffect, useRef, useState } from "react";

export interface GoblinVoice {
  /** id of the message currently playing, or null */
  speakingId: string | null;
  /** id of the message whose audio is being fetched, or null */
  loadingId: string | null;
  /** Start reading a message aloud, or stop it if it is already the active one. */
  toggle: (id: string, text: string) => void;
  /** Stop any playback immediately. */
  stop: () => void;
}

/** Owns a single <audio> element and plays a goblin ruling via /api/tts. One thing speaks at a time. */
export function useGoblinVoice(): GoblinVoice {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const genRef = useRef(0); // bumped on every stop()/toggle; stale in-flight requests no-op
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const teardown = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const stop = useCallback(() => {
    genRef.current += 1; // invalidate any in-flight /api/tts request
    abortRef.current?.abort();
    abortRef.current = null;
    teardown();
    setSpeakingId(null);
    setLoadingId(null);
  }, [teardown]);

  const toggle = useCallback(
    (id: string, text: string) => {
      if (speakingId === id || loadingId === id) {
        stop();
        return;
      }
      stop(); // tear down current playback and bump the generation
      const clean = text.replace(/\[\d+\]/g, "").trim(); // drop inline [1][2] citation markers
      if (!clean) return;

      const gen = genRef.current; // this request's generation; a newer stop()/toggle supersedes it
      const controller = new AbortController();
      abortRef.current = controller;
      setLoadingId(id);

      fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean }),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`tts ${res.status}`);
          const blob = await res.blob();
          if (gen !== genRef.current) return; // superseded while fetching — drop it
          const url = URL.createObjectURL(blob);
          const audio = new Audio(url);
          audio.onended = stop;
          audio.onerror = stop;
          urlRef.current = url;
          audioRef.current = audio;
          await audio.play();
          if (gen !== genRef.current) {
            // superseded during the play() gap — clean up our own resources, touch no shared state
            audio.pause();
            URL.revokeObjectURL(url);
            return;
          }
          setLoadingId(null);
          setSpeakingId(id);
        })
        .catch(() => {
          if (gen === genRef.current) stop(); // ignore aborts/errors from superseded requests
        });
    },
    [speakingId, loadingId, stop],
  );

  useEffect(() => teardown, [teardown]); // stop on unmount

  return { speakingId, loadingId, toggle, stop };
}
