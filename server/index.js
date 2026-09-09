import cors from "cors";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const PORT = Number(process.env.PORT) || 3001;
const apiKey = process.env.OPENAI_API_KEY;
const model = process.env.REALTIME_MODEL || "gpt-realtime-2.1";
const voice = process.env.VOICE || "marin";

const sessionConfig = JSON.stringify({
  type: "realtime",
  model,
  instructions: [
    "You are a real-time voice assistant.",
    "Speak naturally, clearly, and concisely.",
    "Reply in the same language the user is speaking.",
    "If the user speaks Urdu or mixed Urdu/English (Roman Urdu), reply the same way.",
    "Keep answers short unless the user asks for detail.",
    "If you are unsure, say so and ask a brief follow-up.",
  ].join(" "),
  audio: {
    input: {
      transcription: {
        model: "gpt-4o-mini-transcribe",
      },
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 300,
        silence_duration_ms: 500,
      },
    },
    output: {
      voice,
    },
  },
});

const extraOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const allowedOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://ai-voice-agent-frontend-dun.vercel.app",
  ...extraOrigins,
];

const app = express();

app.use(
  cors({
    origin(origin, callback) {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.endsWith(".vercel.app")
      ) {
        callback(null, true);
        return;
      }
      callback(new Error("Not allowed by CORS"));
    },
  })
);
app.use(express.text({ type: ["application/sdp", "text/plain"] }));
app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    hasApiKey: Boolean(apiKey),
    model,
    voice,
  });
});

app.post("/api/session", async (req, res) => {
  if (!apiKey) {
    res.status(500).json({
      error: "OPENAI_API_KEY is missing. Add it to server/.env",
    });
    return;
  }

  if (!req.body || typeof req.body !== "string") {
    res.status(400).json({ error: "SDP offer is required" });
    return;
  }

  try {
    const form = new FormData();
    form.set("sdp", req.body);
    form.set("session", sessionConfig);

    const openaiRes = await fetch("https://api.openai.com/v1/realtime/calls", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: form,
    });

    const payload = await openaiRes.text();

    if (!openaiRes.ok) {
      console.error("OpenAI session error:", openaiRes.status, payload);
      res.status(openaiRes.status).type("application/json").send(payload);
      return;
    }

    res.status(openaiRes.status).type("application/sdp").send(payload);
  } catch (error) {
    console.error("Session creation failed:", error);
    res.status(500).json({ error: "Failed to create realtime session" });
  }
});

if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Voice agent server on http://localhost:${PORT}`);
    if (!apiKey) {
      console.warn("OPENAI_API_KEY is not set. Copy server/.env.example to server/.env");
    }
  });
}

export default app;
