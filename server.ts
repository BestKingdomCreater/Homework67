import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ALLOWED_MODELS = new Set(['gemini-4-hydrogen', 'gemini-3.1-flash-lite']);
const DEFAULT_MODEL = 'gemini-4-hydrogen';

function getServerApiKey(): string {
  return (process.env.GEMINI_API_KEY || '').trim();
}

function getAiClient(): GoogleGenAI | null {
  const apiKey = getServerApiKey();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function startServer(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/gemini/status', (_req, res) => {
    res.json({
      connected: getServerApiKey().length > 0,
      defaultModel: DEFAULT_MODEL,
      models: Array.from(ALLOWED_MODELS),
    });
  });

  app.post('/api/gemini/generate', async (req, res) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({
        error: 'GEMINI_API_KEY is not configured in Settings > Secrets.',
      });
      return;
    }

    const body = req.body as { prompt?: unknown; model?: unknown } | undefined;
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 8000) {
      res.status(400).json({ error: 'Prompt must be a non-empty string under 8000 characters.' });
      return;
    }

    const requestedModel = typeof body?.model === 'string' ? body.model.trim() : DEFAULT_MODEL;
    const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;

    try {
      const config: {
        responseMimeType: string;
        thinkingConfig?: { thinkingLevel: ThinkingLevel };
      } = {
        responseMimeType: 'application/json',
      };
      if (model === 'gemini-4-hydrogen') {
        config.thinkingConfig = { thinkingLevel: ThinkingLevel.LOW };
      }

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });

      const raw = (response.text || '{}').trim();
      const cleaned = raw.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { speech: cleaned.slice(0, 110) };
      }

      res.json({ ok: true, model, parsed });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Gemini generation failed';
      const status = typeof (err as { status?: unknown })?.status === 'number'
        ? (err as { status: number }).status
        : 502;
      res.status(status >= 400 && status < 600 ? status : 502).json({
        error: message,
      });
    }
  });

  const isProd = process.env.NODE_ENV === 'production';
  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  const port = Number(process.env.PORT || 3000);
  app.listen(port, '0.0.0.0', () => {
    console.log(`Chronicles of Terra server listening on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
