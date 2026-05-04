import { useState, useRef, useEffect, useCallback } from 'react';

// Priority list of natural-sounding voices, best-first.
// "premium/enhanced/neural" markers first, then known good named voices.
const PREMIUM_HINTS = /(premium|enhanced|neural|natural|online|wavenet|studio)/i;
const NAMED_PRIORITY = [
  /^samantha/i,            // macOS / iOS — top tier natural
  /^ava\b/i,               // macOS premium female
  /^allison/i,             // macOS enhanced
  /^karen/i,               // macOS AU female
  /^serena/i,              // macOS UK female
  /^daniel/i,              // macOS UK male
  /^tom\b/i,               // macOS US male
  /^aria/i,                // Edge / Windows neural female
  /^jenny/i,               // Edge / Windows neural female
  /^guy\b/i,               // Edge neural male
  /microsoft.*(aria|jenny|guy|davis|jane)/i,
  /google\s+us\s+english/i,
  /google.*english.*united states/i,
];

function pickBestVoice(voices) {
  if (!voices?.length) return null;
  const en = voices.filter(v => /^en[-_]/i.test(v.lang) || /english/i.test(v.name));
  const enUS = en.filter(v => /en[-_]us/i.test(v.lang));
  const pool = enUS.length ? enUS : en;

  // 1. Named priority voices in pool
  for (const re of NAMED_PRIORITY) {
    const v = pool.find(x => re.test(x.name));
    if (v) return v;
  }
  // 2. Premium / neural hints
  const premium = pool.find(v => PREMIUM_HINTS.test(v.name));
  if (premium) return premium;
  // 3. Local (non-network) usually higher quality on macOS/iOS
  const local = pool.find(v => v.localService);
  if (local) return local;
  // 4. Anything English
  return pool[0] || voices[0];
}

function loadVoices() {
  return new Promise(resolve => {
    if (!('speechSynthesis' in window)) return resolve([]);
    let v = window.speechSynthesis.getVoices();
    if (v && v.length) return resolve(v);
    const handler = () => {
      v = window.speechSynthesis.getVoices();
      if (v && v.length) {
        window.speechSynthesis.removeEventListener('voiceschanged', handler);
        resolve(v);
      }
    };
    window.speechSynthesis.addEventListener('voiceschanged', handler);
    setTimeout(() => resolve(window.speechSynthesis.getVoices() || []), 1500);
  });
}

// Split a reply into natural speech "beats" — sentences and major clauses —
// so we can vary pitch slightly per beat and insert micro-pauses.
function splitIntoBeats(text) {
  const cleaned = text
    .replace(/[*_`#]+/g, '')           // strip markdown
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];
  // Split on sentence enders, keeping the punctuation.
  const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [cleaned];
  const beats = [];
  for (const s of sentences) {
    const t = s.trim();
    if (!t) continue;
    // Further split very long sentences on em dashes / semicolons for breath points
    if (t.length > 140 && /[—;:]/.test(t)) {
      const parts = t.split(/\s*[—;:]\s*/).filter(Boolean);
      beats.push(...parts);
    } else {
      beats.push(t);
    }
  }
  return beats;
}

export function useVoice({ onTranscript } = {}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState('');
  const [supported, setSupported] = useState(true);
  const [voiceName, setVoiceName] = useState('');
  const recognitionRef = useRef(null);
  const voiceRef = useRef(null);
  const speakSeqRef = useRef(0);

  // Pre-warm voices (some browsers populate async)
  useEffect(() => {
    let alive = true;
    loadVoices().then(vs => {
      if (!alive) return;
      const v = pickBestVoice(vs);
      voiceRef.current = v;
      if (v) setVoiceName(v.name);
    });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { setSupported(false); return; }
    const r = new SR();
    r.continuous = false;
    r.interimResults = true;
    r.lang = 'en-US';
    r.onresult = (e) => {
      let finalT = '';
      let interimT = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalT += t;
        else interimT += t;
      }
      setInterim(interimT);
      if (finalT && onTranscript) onTranscript(finalT.trim());
    };
    r.onend = () => { setListening(false); setInterim(''); };
    r.onerror = () => { setListening(false); setInterim(''); };
    recognitionRef.current = r;
  }, [onTranscript]);

  const startListening = useCallback(() => {
    const r = recognitionRef.current;
    if (!r || listening) return;
    try {
      window.speechSynthesis?.cancel();
      r.start();
      setListening(true);
    } catch {}
  }, [listening]);

  const stopListening = useCallback(() => {
    try { recognitionRef.current?.stop(); } catch {}
    setListening(false);
  }, []);

  const speak = useCallback(async (text) => {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();

    // Make sure we have a voice (handles cold start)
    if (!voiceRef.current) {
      const vs = await loadVoices();
      voiceRef.current = pickBestVoice(vs);
      if (voiceRef.current) setVoiceName(voiceRef.current.name);
    }

    const beats = splitIntoBeats(text);
    if (!beats.length) return;

    const seq = ++speakSeqRef.current;
    setSpeaking(true);

    // Per-beat slight pitch + rate variation for human-like cadence.
    // Base: slightly slower than default, warm pitch.
    const basePitch = 1.02;
    const baseRate = 0.97;

    beats.forEach((beat, i) => {
      const u = new SpeechSynthesisUtterance(beat);
      if (voiceRef.current) u.voice = voiceRef.current;
      u.lang = voiceRef.current?.lang || 'en-US';
      // Subtle natural variation: ±0.06 pitch, ±0.03 rate per beat
      const pitchJitter = (Math.sin(i * 1.7) * 0.06);
      const rateJitter = (Math.cos(i * 1.3) * 0.03);
      u.pitch = Math.max(0.85, Math.min(1.15, basePitch + pitchJitter));
      u.rate = Math.max(0.9, Math.min(1.0, baseRate + rateJitter));
      u.volume = 1.0;
      // Trailing punctuation already gives a natural pause; add a tiny gap
      // between sentences via a brief silent utterance for breath.
      if (i === 0) u.onstart = () => { if (seq === speakSeqRef.current) setSpeaking(true); };
      if (i === beats.length - 1) {
        u.onend = () => { if (seq === speakSeqRef.current) setSpeaking(false); };
        u.onerror = () => { if (seq === speakSeqRef.current) setSpeaking(false); };
      }
      window.speechSynthesis.speak(u);

      // Insert a short silent "breath" utterance between beats (180ms-ish)
      if (i < beats.length - 1) {
        const breath = new SpeechSynthesisUtterance(' ');
        if (voiceRef.current) breath.voice = voiceRef.current;
        breath.lang = u.lang;
        breath.volume = 0;
        breath.rate = 0.5;
        window.speechSynthesis.speak(breath);
      }
    });
  }, []);

  const stopSpeaking = useCallback(() => {
    speakSeqRef.current++;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  return {
    listening, speaking, interim, supported, voiceName,
    startListening, stopListening, speak, stopSpeaking,
  };
}
