const axios = require('axios');

class LLMService {
  constructor() {
    this.models = {
      gemini: process.env.GEMINI_API_KEY,
      claude: process.env.ANTHROPIC_API_KEY,
      gpt4o: process.env.OPENAI_API_KEY,
      grok: process.env.GROK_API_KEY,
    };
  }

  async queryGemini(prompt) {
    if (!this.models.gemini) return null;
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.models.gemini}`,
        { contents: [{ parts: [{ text: prompt }] }] },
        { timeout: 15000 }
      );
      const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      return this.parseSignal(text, 'gemini');
    } catch (e) {
      console.error('[Gemini] Error:', e.message);
      return null;
    }
  }

  async queryClaude(prompt) {
    if (!this.models.claude) return null;
    try {
      const response = await axios.post(
        'https://api.anthropic.com/v1/messages',
        {
          model: 'claude-3-5-haiku-20241022',
          max_tokens: 256,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'x-api-key': this.models.claude,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const text = response.data?.content?.[0]?.text || '';
      return this.parseSignal(text, 'claude');
    } catch (e) {
      console.error('[Claude] Error:', e.message);
      return null;
    }
  }

  async queryGPT4o(prompt) {
    if (!this.models.gpt4o) return null;
    try {
      const response = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 256,
        },
        {
          headers: {
            Authorization: `Bearer ${this.models.gpt4o}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const text = response.data?.choices?.[0]?.message?.content || '';
      return this.parseSignal(text, 'gpt4o');
    } catch (e) {
      console.error('[GPT-4o] Error:', e.message);
      return null;
    }
  }

  async queryGrok(prompt) {
    if (!this.models.grok) return null;
    try {
      const response = await axios.post(
        'https://api.x.ai/v1/chat/completions',
        {
          model: 'grok-2-latest',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 256,
        },
        {
          headers: {
            Authorization: `Bearer ${this.models.grok}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        }
      );
      const text = response.data?.choices?.[0]?.message?.content || '';
      return this.parseSignal(text, 'grok');
    } catch (e) {
      console.error('[Grok] Error:', e.message);
      return null;
    }
  }

  parseSignal(text, model) {
    const upper = text.toUpperCase();
    let action = 'HOLD';
    if (upper.includes('BUY')) action = 'BUY';
    else if (upper.includes('SELL')) action = 'SELL';

    const confMatch = text.match(/confidence[:\s]+(\d+(?:\.\d+)?)/i);
    const confidence = confMatch ? parseFloat(confMatch[1]) / 100 : 0.5 + Math.random() * 0.3;

    return { model, action, confidence: Math.min(1, confidence), rawText: text.slice(0, 200) };
  }

  async getEnsembleSignal(symbol, priceData, sentiment) {
    const prompt = `You are a professional quantitative trading analyst.
Analyze ${symbol} and provide a trading signal.

Recent price data: ${JSON.stringify(priceData)}
Market sentiment: ${sentiment}

Respond with exactly one of: BUY, SELL, or HOLD
Then on a new line: Confidence: XX% (e.g. Confidence: 72%)
Then a 1-2 sentence rationale.`;

    const [geminiResult, claudeResult, gpt4oResult, grokResult] = await Promise.allSettled([
      this.queryGemini(prompt),
      this.queryClaude(prompt),
      this.queryGPT4o(prompt),
      this.queryGrok(prompt),
    ]);

    const results = [geminiResult, claudeResult, gpt4oResult, grokResult]
      .filter(r => r.status === 'fulfilled' && r.value !== null)
      .map(r => r.value);

    if (results.length === 0) {
      return { consensus: 'HOLD', confidence: 0, votes: {}, results: [], reason: 'No LLMs available' };
    }

    const votes = { BUY: 0, SELL: 0, HOLD: 0 };
    results.forEach(r => { votes[r.action] = (votes[r.action] || 0) + 1; });

    const consensus = Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
    const avgConfidence = results.reduce((s, r) => s + r.confidence, 0) / results.length;

    return { consensus, confidence: avgConfidence, votes, results, reason: `${results.length} LLMs voted` };
  }
}

module.exports = new LLMService();
