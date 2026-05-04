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

  return {
    listening, speaking, interim, supported,
    voices, voiceId, setVoiceId, engine,
    startListening, stopListening, speak, stopSpeaking,
  };
}
