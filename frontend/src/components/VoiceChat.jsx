import { useState, useEffect, useRef, useCallback } from 'react';
import { useVoice } from '../hooks/useVoice';

const GREETING = "Hi, I'm Alpha — your personal broker. I'm watching the market and your portfolio in real time. Ask me anything, or tell me to make a move.";

export default function VoiceChat({ open, onClose, brokerChat }) {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: GREETING },
  ]);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [autoSpeak, setAutoSpeak] = useState(true);
  const scrollRef = useRef(null);
  const greetedRef = useRef(false);

  const send = useCallback(async (text) => {
    if (!text || thinking) return;
    const next = [...messages, { role: 'user', content: text }];
    setMessages(next);
    setInput('');
    setThinking(true);
    try {
      const r = await brokerChat(next.map(m => ({ role: m.role, content: m.content })));
      const reply = r?.reply || 'Sorry, no response.';
      setMessages(m => [...m, { role: 'assistant', content: reply }]);
      if (autoSpeak) speak(reply);
    } catch (e) {
      setMessages(m => [...m, { role: 'assistant', content: `Connection error: ${e.message}` }]);
    } finally {
      setThinking(false);
    }
  }, [messages, thinking, brokerChat, autoSpeak]);

  const { listening, speaking, interim, supported, voices, voiceId, setVoiceId, engine, startListening, stopListening, speak, stopSpeaking } =
    useVoice({ onTranscript: (t) => send(t) });
  const currentVoice = voices.find(v => v.voice_id === voiceId);

  useEffect(() => {
    if (open && !greetedRef.current && autoSpeak) {
      greetedRef.current = true;
      setTimeout(() => speak(GREETING), 400);
    }
  }, [open, autoSpeak, speak]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, interim]);

  useEffect(() => {
    if (!open) { stopListening(); stopSpeaking(); }
  }, [open, stopListening, stopSpeaking]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] anim-fade">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-md" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 sm:inset-0 sm:flex sm:items-center sm:justify-center anim-slide-up">
        <div className="glass-strong w-full sm:max-w-lg sm:max-h-[85vh] mx-auto flex flex-col"
          style={{ maxHeight: '92vh', borderRadius: '28px 28px 0 0' }}>
          {/* Header */}
          <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-white/5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#0a84ff] to-[#bf5af2] flex items-center justify-center text-lg">🎙</div>
              <div>
                <div className="font-semibold text-[15px]">Alpha · Your Broker</div>
                <div className="text-[11px] text-[var(--text-dim)] flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full ${listening ? 'bg-[var(--red)]' : speaking ? 'bg-[var(--blue)]' : 'bg-[var(--green)]'}`} />
                  {listening ? 'Listening…' : speaking ? 'Speaking…' : thinking ? 'Thinking…' : 'Ready'}
                  <span className="opacity-60 ml-1">· {engine === 'grok' ? 'Grok TTS' : 'Browser'}{currentVoice ? ` · ${currentVoice.name}` : ''}</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1">
              {voices.length > 0 && (
                <select
                  value={voiceId}
                  onChange={(e) => setVoiceId(e.target.value)}
                  title="Pick Alpha's voice"
                  className="bg-white/5 border border-white/10 rounded-full px-2.5 py-1 text-[11px] text-[var(--text)] outline-none focus:border-[var(--blue)] max-w-[100px]">
                  {voices.map(v => (
                    <option key={v.voice_id} value={v.voice_id} className="bg-[#0a0a0a]">
                      {v.name}{v.gender ? ` · ${v.gender[0].toUpperCase()}` : ''}
                    </option>
                  ))}
                </select>
              )}
              <button onClick={() => setAutoSpeak(s => !s)}
                className="p-2 rounded-full hover:bg-white/10 text-sm"
                title={autoSpeak ? 'Mute voice replies' : 'Enable voice replies'}>
                {autoSpeak ? '🔊' : '🔇'}
              </button>
              <button onClick={onClose}
                className="p-2 rounded-full hover:bg-white/10 text-[var(--text-dim)]">✕</button>
            </div>
          </div>

          {/* Messages */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-[300px]">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] leading-snug ${
                  m.role === 'user'
                    ? 'bg-[var(--blue)] text-white rounded-br-md'
                    : 'bg-white/5 text-[var(--text)] rounded-bl-md border border-white/5'
                }`}>{m.content}</div>
              </div>
            ))}
            {interim && (
              <div className="flex justify-end">
                <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-[14px] bg-[var(--blue)]/40 text-white italic">
                  {interim}…
                </div>
              </div>
            )}
            {thinking && (
              <div className="flex justify-start">
                <div className="bg-white/5 rounded-2xl px-4 py-3 border border-white/5 flex gap-1">
                  <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '120ms' }} />
                  <span className="w-1.5 h-1.5 bg-white/50 rounded-full animate-bounce" style={{ animationDelay: '240ms' }} />
                </div>
              </div>
            )}
          </div>

          {/* Input bar */}
          <div className="border-t border-white/5 px-4 py-3 safe-bottom">
            <div className="flex items-center gap-2">
              <input
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && send(input.trim())}
                placeholder={supported ? 'Type or tap mic to talk…' : 'Type your message…'}
                className="flex-1 bg-white/5 border border-white/10 rounded-full px-4 py-2.5 text-[14px] outline-none focus:border-[var(--blue)] transition-colors"
              />
              {supported && (
                <button
                  onClick={() => listening ? stopListening() : startListening()}
                  className={`w-11 h-11 rounded-full flex items-center justify-center text-lg transition-colors ${
                    listening ? 'bg-[var(--red)] text-white pulse-mic' : 'bg-white/5 hover:bg-white/10 border border-white/10'
                  }`}
                  title={listening ? 'Stop listening' : 'Tap to talk'}>
                  {listening ? '⏹' : '🎤'}
                </button>
              )}
              <button
                onClick={() => send(input.trim())}
                disabled={!input.trim() || thinking}
                className="w-11 h-11 rounded-full bg-[var(--blue)] text-white flex items-center justify-center disabled:opacity-30">
                ↑
              </button>
            </div>
            {!supported && (
              <div className="text-[10px] text-[var(--text-dim)] mt-2 text-center">
                Voice input requires Chrome, Edge, or Safari
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
