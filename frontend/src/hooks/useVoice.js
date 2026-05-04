import { useState, useRef, useEffect, useCallback } from 'react';

export function useVoice({ onTranscript } = {}) {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [interim, setInterim] = useState('');
  const [supported, setSupported] = useState(true);
  const recognitionRef = useRef(null);

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

  const speak = useCallback((text) => {
    if (!('speechSynthesis' in window) || !text) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.05; u.pitch = 1.0; u.volume = 1.0;
    const voices = window.speechSynthesis.getVoices();
    const preferred = voices.find(v => /samantha|aria|jenny|google.*us/i.test(v.name)) || voices.find(v => v.lang.startsWith('en'));
    if (preferred) u.voice = preferred;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, []);

  const stopSpeaking = useCallback(() => {
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  return { listening, speaking, interim, supported, startListening, stopListening, speak, stopSpeaking };
}
