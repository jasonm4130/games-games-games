import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeakResult } from "../shared/types";

export interface GoblinVoice {
  /** id of the message currently playing, or null */
  speakingId: string | null;
  /** id of the message whose audio is being fetched, or null */
  loadingId: string | null;
  /** id of the message whose last speak attempt failed, or null (cleared on the next toggle) */
  errorId: string | null;
  /** Start reading a message aloud, or stop it if it is already the active one. */
  toggle: (id: string) => void;
  /** Stop any playback immediately. */
  stop: () => void;
}

/** Decode a base64 MP3 (from the agent `speak` RPC) into a Blob for playback. */
function base64ToBlob(base64: string, type: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type });
}

/**
 * Owns a single <audio> element and plays a goblin ruling via the RulesAgent `speak` RPC (there is
 * no public TTS route — the audio rides the authenticated agent WebSocket). One thing speaks at a
 * time. `speak` resolves a message id to its MP3 (base64) or an in-character failure reason.
 */
export function useGoblinVoice(speak: (messageId: string) => Promise<SpeakResult>): GoblinVoice {
  const speakRef = useRef(speak);
  speakRef.current = speak; // keep the latest stub without re-creating `toggle`
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);
  const genRef = useRef(0); // bumped on every stop()/toggle; stale in-flight requests no-op
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

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
    genRef.current += 1; // invalidate any in-flight speak request
    teardown();
    setSpeakingId(null);
    setLoadingId(null);
  }, [teardown]);

  const toggle = useCallback(
    (id: string) => {
      if (speakingId === id || loadingId === id) {
        stop();
        return;
      }
      stop(); // tear down current playback and bump the generation
      setErrorId(null);

      const gen = genRef.current; // this request's generation; a newer stop()/toggle supersedes it
      setLoadingId(id);

      speakRef
        .current(id)
        .then(async (result) => {
          if (gen !== genRef.current) return; // superseded while fetching — drop it
          if (!result.ok) {
            setLoadingId(null);
            setErrorId(id);
            return;
          }
          const url = URL.createObjectURL(base64ToBlob(result.audio, "audio/mpeg"));
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
          if (gen !== genRef.current) return; // ignore superseded requests
          setLoadingId(null);
          setErrorId(id);
        });
    },
    [speakingId, loadingId, stop],
  );

  useEffect(() => teardown, [teardown]); // stop on unmount

  return { speakingId, loadingId, errorId, toggle, stop };
}
