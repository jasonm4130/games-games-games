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
      stop();
      const clean = text.replace(/\[\d+\]/g, "").trim(); // drop inline [1][2] citation markers
      if (!clean) return;
      setLoadingId(id);
      fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: clean }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`tts ${res.status}`);
          const url = URL.createObjectURL(await res.blob());
          urlRef.current = url;
          const audio = new Audio(url);
          audioRef.current = audio;
          audio.onended = stop;
          audio.onerror = stop;
          await audio.play();
          setLoadingId(null);
          setSpeakingId(id);
        })
        .catch(stop);
    },
    [speakingId, loadingId, stop],
  );

  useEffect(() => teardown, [teardown]); // stop on unmount

  return { speakingId, loadingId, toggle, stop };
}
