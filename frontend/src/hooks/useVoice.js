import { useState, useRef, useEffect, useCallback } from 'react';

// Web Speech API fallback voice picker (used only if Grok TTS fails)
const FALLBACK_NAMED = [/samantha/i, /ava\b/i, /aria/i, /jenny/i, /google\s+us\s+english/i];
function pickFallbackVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = window.speechSynthesis.getVoices() || [];
  const en = voices.filter(v => /^en[-_]/i.test(v.lang));
  for (const re of FALLBACK_NAMED) { const v = en.find(x => re.test(x.name)); if (v) return v; }
  return en.find(v => v.localService) || en[0] || voices[0] || null;
}

// Strip markdown so the voice never reads asterisks etc.
function cleanForSpeech(text) {
  return String(text || '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function useVoice({ onTranscript, defaultVoiceId = 'eve' } = {}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState('');
  const [supported, setSupported] = useState(true);
  const [voices, setVoices] = useState([]);
  const [voiceId, setVoiceId] = useState(defaultVoiceId);
  const [engine, setEngine] = useState('grok'); // 'grok' | 'browser'

  const recognitionRef = useRef(null);
  const audioRef = useRef(null);
  const speakSeqRef = useRef(0);
  const objectUrlRef = useRef(null);
  // Ordered audio queue for streamed TTS chunks (one per sentence)
  const queueSessionRef = useRef(0);
  const queueRef = useRef({ next: 0, pending: new Map(), playing: false, urls: [] });

  // Load Grok voices once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch('/api/broker/voices');
        if (!r.ok) return;
        const j = await r.json();
        if (!alive) return;
        setVoices(j.voices || []);
        if (j.default && !voiceId) setVoiceId(j.default);
      } catch {}
    })();
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Speech recognition (input)
  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = 'en-US';
    r.onresult = (e) => {
      let finalT = '', interimT = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t; else interimT += t;
      }
      setInterim(interimT);
      if (finalT && onTranscript) onTranscript(finalT.trim());
    };
    r.onend = () => { setListening(false); setInterim(''); };
    r.onerror = () => { setListening(false); setInterim(''); };
    recognitionRef.current = r;
  }, [onTranscript]);

  const stopAudio = useCallback(() => {
    if (audioRef.current) {
      try { audioRef.current.pause(); audioRef.current.src = ''; } catch {}
      audioRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    // Clear streamed-audio queue
    const q = queueRef.current;
    q.urls.forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
    queueRef.current = { next: 0, pending: new Map(), playing: false, urls: [] };
    queueSessionRef.current++;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const startListening = useCallback(() => {
    const r = recognitionRef.current;
    if (!r || listening) return;
    try { stopAudio(); r.start(); setListening(true); } catch {}
  }, [listening, stopAudio]);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch {}
    setListening(false);
  }, []);

  // Browser-TTS fallback (sentence-beat speaking, slight jitter)
  const speakBrowserFallback = useCallback((text) => {
    if (!('speechSynthesis' in window)) return;
    const v = pickFallbackVoice();
    const beats = text.split(/(?<=[.!?])\s+/).filter(Boolean);
    setSpeaking(true);
    const seq = ++speakSeqRef.current;
    beats.forEach((beat, i) => {
      const u = new SpeechSynthesisUtterance(beat);
      if (v) u.voice = v;
      // Punchier fallback delivery to match Grok-TTS energy
      u.rate = 1.12 + (Math.cos(i * 1.3) * 0.03);
      u.pitch = 1.04 + (Math.sin(i * 1.7) * 0.05);
      if (i === beats.length - 1) {
        u.onend = () => { if (seq === speakSeqRef.current) setSpeaking(false); };
        u.onerror = () => { if (seq === speakSeqRef.current) setSpeaking(false); };
      }
      window.speechSynthesis.speak(u);
    });
  }, []);

  // Primary: Grok TTS via backend proxy
  const speak = useCallback(async (rawText, opts = {}) => {
    const text = cleanForSpeech(rawText);
    if (!text) return;
    stopAudio();
    const seq = ++speakSeqRef.current;
    setSpeaking(true);
    try {
      const res = await fetch('/api/broker/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: opts.voice || voiceId, language: opts.language || 'en' }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      if (seq !== speakSeqRef.current) return; // superseded by another speak()
      const blob = await res.blob();
      if (seq !== speakSeqRef.current) return;
      const url = URL.createObjectURL(blob);
      objectUrlRef.current = url;
      const audio = new Audio(url);
      audio.preload = 'auto';
      // Punchier broker delivery — speed up ~12% while preserving pitch so
      // Eve still sounds natural, not chipmunked.
      audio.playbackRate = opts.rate ?? 1.12;
      audio.preservesPitch = true;
      audio.mozPreservesPitch = true;
      audio.webkitPreservesPitch = true;
      audioRef.current = audio;
      audio.onended = () => { if (seq === speakSeqRef.current) { setSpeaking(false); stopAudio(); } };
      audio.onerror = () => { if (seq === speakSeqRef.current) { setSpeaking(false); stopAudio(); } };
      setEngine('grok');
      await audio.play();
    } catch (e) {
      console.warn('[Voice] Grok TTS failed, falling back to browser TTS:', e.message);
      setEngine('browser');
      speakBrowserFallback(text);
    }
  }, [voiceId, stopAudio, speakBrowserFallback]);

  const stopSpeaking = useCallback(() => {
    speakSeqRef.current++;
    stopAudio();
    setSpeaking(false);
  }, [stopAudio]);

  // Drain the queue: play audio chunks in seq order. Each chunk is an MP3 blob URL.
  const drainQueue = useCallback((session) => {
    const q = queueRef.current;
    if (q.playing || session !== queueSessionRef.current) return;
    const url = q.pending.get(q.next);
    if (!url) return; // wait for next-in-order chunk
    q.pending.delete(q.next);
    q.next++;
    q.playing = true;
    setSpeaking(true);
    setEngine('grok');
    const audio = new Audio(url);
    audio.preload = 'auto';
    audio.playbackRate = 1.12;
    audio.preservesPitch = true;
    audio.mozPreservesPitch = true;
    audio.webkitPreservesPitch = true;
    audioRef.current = audio;
    const cleanupAndNext = () => {
      try { URL.revokeObjectURL(url); } catch {}
      q.urls = q.urls.filter(u => u !== url);
      q.playing = false;
      if (session !== queueSessionRef.current) return;
      if (q.pending.size > 0 || q.next === 0) {
        drainQueue(session);
      } else {
        // No more pending right now — speaking may resume when next chunk arrives
        setSpeaking(false);
      }
    };
    audio.onended = cleanupAndNext;
    audio.onerror = cleanupAndNext;
    audio.play().catch(cleanupAndNext);
  }, []);

  // Streamed chat: POSTs to /api/broker/chat-stream (SSE), parses events,
  // and pipes per-sentence audio chunks straight into the play queue.
  const streamChat = useCallback(async (messages, { onDelta, onDone, onError } = {}) => {
    stopAudio(); // cancel any in-flight playback
    const session = queueSessionRef.current; // captured AFTER stopAudio bumps it
    let fullText = '';
    let firstAudioAt = null;
    const t0 = performance.now();
    try {
      const res = await fetch('/api/broker/chat-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, voice: true }),
      });
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const handleEvent = (event, dataStr) => {
        if (session !== queueSessionRef.current) return;
        let data; try { data = JSON.parse(dataStr); } catch { return; }
        if (event === 'delta') {
          fullText += data.text;
          onDelta?.(data.text, fullText);
        } else if (event === 'audio') {
          // base64 → Blob → object URL → enqueue
          const bin = atob(data.b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          const blob = new Blob([bytes], { type: data.contentType || 'audio/mpeg' });
          const url = URL.createObjectURL(blob);
          if (firstAudioAt === null) firstAudioAt = performance.now() - t0;
          const q = queueRef.current;
          q.pending.set(data.seq, url);
          q.urls.push(url);
          drainQueue(session);
        } else if (event === 'done') {
          onDone?.({
            reply: data.reply || fullText,
            totalMs: data.totalMs,
            firstAudioMs: data.firstAudioMs,
            firstAudioClientMs: firstAudioAt,
          });
        } else if (event === 'audio_error') {
          // Skip the failed seq so later chunks don't deadlock waiting in queue
          const q = queueRef.current;
          if (typeof data.seq === 'number') {
            q.pending.delete(data.seq);
            if (data.seq === q.next) {
              q.next++;
              drainQueue(session);
            }
          }
          console.warn('[Voice] audio_error seq=', data.seq, data.error);
        } else if (event === 'error') {
          onError?.(new Error(data.error || 'stream error'));
        }
      };

      // SSE parser: events delimited by blank line; lines like "event: x" / "data: ..."
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let dataLines = [];
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
          }
          if (dataLines.length) handleEvent(event, dataLines.join('\n'));
        }
      }
    } catch (e) {
      console.error('[Voice] streamChat error:', e.message);
      onError?.(e);
    }
    return { reply: fullText, firstAudioClientMs: firstAudioAt };
  }, [stopAudio, drainQueue]);

  return {
    listening, speaking, interim, supported,
    voices, voiceId, setVoiceId, engine,
    startListening, stopListening, speak, stopSpeaking,
    streamChat,
  };
}
