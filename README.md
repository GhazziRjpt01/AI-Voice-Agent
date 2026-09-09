# AI-Voice-Agent

Realtime speech-to-speech voice agent: React frontend + Node.js backend. The OpenAI API key stays on the server. The browser sends microphone audio over WebRTC; OpenAI Realtime replies with live voice.

## Setup

1. Copy `server/.env.example` to `server/.env` and put your key in `OPENAI_API_KEY`.
2. Install and run:

```bash
npm install
npm run install:all
npm run dev
```

3. Open [http://localhost:5173](http://localhost:5173), click **Start talking**, and allow the microphone.

Production frontend ([ai-voice-agent-frontend-dun.vercel.app](https://ai-voice-agent-frontend-dun.vercel.app/)) calls the deployed backend at [ai-voice-agent-backend-ten.vercel.app](https://ai-voice-agent-backend-ten.vercel.app/api/health) via `VITE_API_URL`. After pulling these changes, redeploy both Vercel projects. On the backend, set `FRONTEND_ORIGIN` to the frontend URL if CORS is restricted.

## How it works

- React client captures mic audio and builds a WebRTC offer.
- Node server (`POST /api/session`) attaches the session config and calls OpenAI `/v1/realtime/calls` with your secret key.
- OpenAI returns an SDP answer. Audio plays in the browser. Transcripts come over the `oai-events` data channel.

Never put the API key in the React app.
