import { useEffect, useRef, useState } from "react";

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

const STARTER_PROMPTS = [
  "Introduce yourself briefly.",
  "Help me plan my day.",
  "Talk with me in Urdu.",
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

function statusCopy(status) {
  switch (status) {
    case "connecting":
      return { title: "Connecting", detail: "Starting a stable voice session." };
    case "listening":
      return { title: "Listening", detail: "Speak clearly. Background noise is ignored." };
    case "speaking":
      return { title: "Speaking", detail: "Let the agent finish, then your turn starts." };
    case "connected":
      return { title: "Your turn", detail: "Talk now. The agent waits until you finish." };
    case "error":
      return { title: "Something broke", detail: "End the call and start again." };
    default:
      return { title: "Ready when you are", detail: "Works on phone, tablet, and desktop." };
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
  const mutedRef = useRef(false);
  const speakingRef = useRef(false);
  const eventHandlerRef = useRef(() => {});

  useEffect(() => {
    fetch(apiUrl("/api/health"))
      .then((res) => res.json())
      .then(setHealth)
      .catch(() => setHealth({ ok: false, hasApiKey: false }));
  }, []);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function applyMicGate() {
    const track = streamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !mutedRef.current && !speakingRef.current;
  }

  function setAgentSpeaking(isSpeaking) {
    if (speakingRef.current === isSpeaking) return;
    speakingRef.current = isSpeaking;
    applyMicGate();
    setStatus(isSpeaking ? "speaking" : "connected");
  }

  function pushMessage(role, text) {
    const trimmed = (text || "").trim();
    if (!trimmed) return;
    setMessages((current) => [
      ...current,
      { id: crypto.randomUUID(), role, text: trimmed, at: Date.now() },
    ]);
  }

  function handleRealtimeEvent(event) {
    if (event.type === "input_audio_buffer.speech_started" && !speakingRef.current) {
      setStatus("listening");
    }

    if (event.type === "input_audio_buffer.speech_stopped" && !speakingRef.current) {
      setStatus("connected");
    }

    if (
      event.type === "output_audio_buffer.started" ||
      event.type === "response.output_audio.delta" ||
      event.type === "response.audio.delta"
    ) {
      setAgentSpeaking(true);
    }

    if (
      event.type === "response.done" ||
      event.type === "output_audio_buffer.stopped"
    ) {
      setAgentSpeaking(false);
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

  eventHandlerRef.current = handleRealtimeEvent;

  async function startCall() {
    setError("");
    setMessages([]);
    setStatus("connecting");
    mutedRef.current = false;
    speakingRef.current = false;
    setMuted(false);

    try {
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      });
      pcRef.current = pc;

      const audioEl = audioRef.current;
      if (audioEl) {
        audioEl.autoplay = true;
        audioEl.playsInline = true;
        audioEl.setAttribute("playsinline", "true");
      }

      pc.ontrack = async (event) => {
        if (!audioEl) return;
        audioEl.srcObject = event.streams[0];
        try {
          await audioEl.play();
        } catch {
          // iOS sometimes needs the original tap; Start talking already counts.
        }
      };

      const localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: { ideal: true },
          noiseSuppression: { ideal: true },
          autoGainControl: { ideal: true },
        },
        video: false,
      });
      streamRef.current = localStream;

      const micTrack = localStream.getAudioTracks()[0];
      if (micTrack?.applyConstraints) {
        await micTrack
          .applyConstraints({
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          })
          .catch(() => {});
      }
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      applyMicGate();

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;
      dc.addEventListener("message", (message) => {
        try {
          eventHandlerRef.current(JSON.parse(message.data));
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
        throw new Error(typeof message === "string" ? message : "Session failed");
      }

      await pc.setRemoteDescription({ type: "answer", sdp: answerBody });
      if (audioEl) {
        await audioEl.play().catch(() => {});
      }
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
    speakingRef.current = false;
    mutedRef.current = false;
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
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    applyMicGate();
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
  const copy = statusCopy(status);

  return (
    <div className="page">
      <div className="glow glow-a" />
      <div className="glow glow-b" />

      <header className="topbar">
        <div className="brand">
          <span className="logo" aria-hidden="true" />
          <div>
            <p className="eyebrow">Realtime voice</p>
            <h1>Talk naturally. No cut-offs.</h1>
          </div>
        </div>
        <div className={`health ${health?.hasApiKey ? "ok" : "warn"}`}>
          <i />
          {health?.hasApiKey ? "Live backend" : "Key missing"}
        </div>
      </header>

      <main className="layout">
        <section className="stage">
          <div className={`orb ${status}`} aria-hidden="true">
            <div className="orb-core" />
            <span />
            <span />
            <span />
          </div>
          <p className="status">{copy.title}</p>
          <p className="hint">{copy.detail}</p>

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
              {muted ? "Unmute mic" : "Mute mic"}
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
          <div className="transcript-head">
            <h2>Transcript</h2>
            <span>{messages.length} lines</span>
          </div>
          <div className="log">
            {messages.length === 0 ? (
              <p className="empty">
                Start a call, then speak. The agent waits for a full sentence before
                answering.
              </p>
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
              placeholder={live ? "Type a message" : "Start a call first"}
              disabled={!live}
              enterKeyHint="send"
              autoComplete="off"
            />
            <button className="btn primary send" type="submit" disabled={!live}>
              Send
            </button>
          </form>
        </section>
      </main>

      <audio ref={audioRef} autoPlay playsInline />
    </div>
  );
}
