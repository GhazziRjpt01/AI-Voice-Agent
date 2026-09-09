import { useEffect, useRef, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

const STARTER_PROMPTS = [
  "Introduce yourself in one sentence.",
  "Help me plan my day.",
  "Translate this conversation as we talk.",
];

function apiUrl(path) {
  return `${API_BASE}${path}`;
}

function transcriptFromEvent(event) {
  if (event.type === "conversation.item.input_audio_transcription.completed") {
    return { role: "user", text: event.transcript || event.text || "" };
  }

  if (
    event.type === "response.output_audio_transcript.done" ||
    event.type === "response.audio_transcript.done"
  ) {
    return { role: "assistant", text: event.transcript || "" };
  }

  return null;
}

function statusLabel(status) {
  switch (status) {
    case "connecting":
      return "Connecting";
    case "listening":
      return "Listening";
    case "speaking":
      return "Speaking";
    case "connected":
      return "Ready";
    case "error":
      return "Error";
    default:
      return "Idle";
  }
}

export default function App() {
  const [status, setStatus] = useState("idle");
  const [muted, setMuted] = useState(false);
  const [health, setHealth] = useState(null);
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [textInput, setTextInput] = useState("");

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const streamRef = useRef(null);
  const audioRef = useRef(null);
  const logEndRef = useRef(null);

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, hasApiKey: false }));
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function pushMessage(role, text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role, text: trimmed, at: Date.now() },
    ]);
  }

  function handleRealtimeEvent(event) {
    if (event.type === "input_audio_buffer.speech_started") {
      setStatus("listening");
    }

    if (event.type === "input_audio_buffer.speech_stopped") {
      setStatus("connected");
    }

    if (
      event.type === "response.output_audio.delta" ||
      event.type === "output_audio_buffer.started" ||
      event.type === "response.audio.delta"
    ) {
      setStatus("speaking");
    }

    if (
      event.type === "response.done" ||
      event.type === "output_audio_buffer.stopped"
    ) {
      setStatus("connected");
    }

    const transcript = transcriptFromEvent(event);
    if (transcript) {
      pushMessage(transcript.role, transcript.text);
    }

    if (event.type === "error") {
      setError(event.error?.message || "Realtime session error");
      setStatus("error");
    }
  }

  async function startCall() {
    setError("");
    setStatus("connecting");

    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      const audioEl = audioRef.current;
      pc.ontrack = (event) => {
        if (audioEl) {
          audioEl.srcObject = event.streams[0];
        }
      };

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = localStream;
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (message) => {
        try {
          handleRealtimeEvent(JSON.parse(message.data));
        } catch {
          // ignore non-JSON events
        }
      });

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const sdpResponse = await fetch(apiUrl("/api/session"), {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offer.sdp,
      });

      const answerBody = await sdpResponse.text();
      if (!sdpResponse.ok) {
        let message = answerBody || "Could not start realtime session";
        try {
          const parsed = JSON.parse(answerBody);
          message =
            parsed.error?.message ||
            parsed.error ||
            parsed.message ||
            message;
        } catch {
          // keep raw body
        }
        throw new Error(message);
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerBody });
      setStatus("connected");
    } catch (err) {
      closeMedia();
      setError(err.message || "Microphone or session failed");
      setStatus("error");
    }
  }

  function closeMedia() {
    dcRef.current?.close();
    pcRef.current?.close();
    streamRef.current?.getTracks().forEach((track) => track.stop());
    dcRef.current = null;
    pcRef.current = null;
    streamRef.current = null;
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
    setMuted(false);
  }

  function stopCall() {
    closeMedia();
    setStatus("idle");
  }

  function toggleMute() {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMuted(!track.enabled);
  }

  function sendText(text) {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open" || !text.trim()) return;

    pushMessage("user", text);
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      })
    );
    dc.send(JSON.stringify({ type: "response.create" }));
    setTextInput("");
  }

  const live = status !== "idle" && status !== "error";

  return (
    <div className="page">
      <div className="orb-bg" />
      <header className="topbar">
        <div>
          <p className="eyebrow">OpenAI Realtime</p>
          <h1>Speech-to-speech voice agent</h1>
        </div>
        <div className={`health ${health?.hasApiKey ? "ok" : "warn"}`}>
          {health?.hasApiKey ? "Server key ready" : "Add OPENAI_API_KEY in server/.env"}
        </div>
      </header>

      <main className="layout">
        <section className="stage">
          <div className={`orb ${status}`}>
            <span />
            <span />
            <span />
          </div>
          <p className="status">{statusLabel(status)}</p>
          <p className="hint">
            Mic audio goes to the Node server, then OpenAI Realtime. Your API key never
            leaves the server.
          </p>

          <div className="controls">
            {live ? (
              <button className="btn danger" onClick={stopCall}>
                End call
              </button>
            ) : (
              <button className="btn primary" onClick={startCall}>
                Start talking
              </button>
            )}
            <button className="btn ghost" onClick={toggleMute} disabled={!live}>
              {muted ? "Unmute" : "Mute"}
            </button>
          </div>

          {error ? <p className="error">{error}</p> : null}

          <div className="prompts">
            {STARTER_PROMPTS.map((prompt) => (
              <button
                key={prompt}
                className="chip"
                disabled={!live}
                onClick={() => sendText(prompt)}
              >
                {prompt}
              </button>
            ))}
          </div>
        </section>

        <section className="transcript">
          <h2>Live transcript</h2>
          <div className="log">
            {messages.length === 0 ? (
              <p className="empty">Start a call, then speak. Transcripts appear here.</p>
            ) : (
              messages.map((message) => (
                <article key={message.id} className={`bubble ${message.role}`}>
                  <span>{message.role === "user" ? "You" : "Agent"}</span>
                  <p>{message.text}</p>
                </article>
              ))
            )}
            <div ref={logEndRef} />
          </div>
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              sendText(textInput);
            }}
          >
            <input
              value={textInput}
              onChange={(event) => setTextInput(event.target.value)}
              placeholder={live ? "Type if you prefer not to speak" : "Start a call first"}
              disabled={!live}
            />
            <button className="btn primary" type="submit" disabled={!live}>
              Send
            </button>
          </form>
        </section>
      </main>

      <audio ref={audioRef} autoPlay />
    </div>
  );
}
