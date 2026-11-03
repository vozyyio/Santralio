// Santralio temsilci masası: tarayıcıdan arama alma (SIP-over-WebSocket + WebRTC).
// Temsilci "Mesaiye başla" ile bağlanır: mikrofon izni alınır, SIP kaydı yapılır.
// Kuyruktan gelen arama tarayıcıda çalar; aç, sessize al, kapat. Müsait/molada durumu kuyruğa yansır.

import { useEffect, useRef, useState } from "react";
import { Invitation, Registerer, RegistererState, SessionState, UserAgent, Web, type Session } from "sip.js";
import { api, type Agent } from "./api";

type Phase = "idle" | "connecting" | "ready" | "ringing" | "talking" | "error";
type Call = { from: string; name: string; queue: string | null; did: string | null; startedAt: number | null };

const QUEUE_LABEL = (q: string | null) => (q ? q.charAt(0).toLocaleUpperCase("tr") + q.slice(1) : null);

// Gelen aramada basit bir zil sesi (Web Audio). Tarayıcılar sesi ancak kullanıcı bir düğmeye bastıktan sonra çalar;
// "Mesaiye başla" bu izni de sağlar.
class Ringer {
  private ctx: AudioContext | null = null;
  private timer: number | null = null;
  unlock() {
    this.ctx ??= new AudioContext();
    void this.ctx.resume();
  }
  start() {
    if (!this.ctx || this.timer !== null) return;
    const beep = () => {
      const ctx = this.ctx!;
      for (const [offset, freq] of [
        [0, 440],
        [0.45, 480],
      ]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = freq;
        g.gain.value = 0.08;
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + offset);
        o.stop(ctx.currentTime + offset + 0.4);
      }
    };
    beep();
    this.timer = window.setInterval(beep, 3000);
  }
  stop() {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
  }
}

function duration(since: number | null, now: number) {
  if (!since) return "";
  const s = Math.floor((now - since) / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function AgentDesk() {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [call, setCall] = useState<Call | null>(null);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [now, setNow] = useState(Date.now());
  const ua = useRef<UserAgent | null>(null);
  const registerer = useRef<Registerer | null>(null);
  const session = useRef<Session | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const ringer = useRef(new Ringer());

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Sayfadan çıkarken SIP kaydını kapat.
  useEffect(
    () => () => {
      ringer.current.stop();
      void registerer.current?.unregister().catch(() => {});
      void ua.current?.stop();
    },
    [],
  );

  // Gelen aramada sekme başlığı yanıp söner (sekme arka plandayken fark edilsin).
  useEffect(() => {
    if (phase !== "ringing") {
      document.title = "Santralio Panel";
      return;
    }
    let on = false;
    const t = window.setInterval(() => (document.title = (on = !on) ? "📞 Gelen arama" : "Santralio Panel"), 800);
    return () => window.clearInterval(t);
  }, [phase]);

  const attachRemoteAudio = (s: Session) => {
    const sdh = s.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    if (!sdh || !audio.current) return;
    const stream = new MediaStream();
    for (const r of sdh.peerConnection?.getReceivers() ?? []) if (r.track) stream.addTrack(r.track);
    audio.current.srcObject = stream;
    void audio.current.play().catch(() => {});
  };

  const onInvite = (inv: Invitation) => {
    // Görüşmedeyken ikinci arama reddedilir (kuyruk zaten meşgul temsilciyi çaldırmaz).
    if (session.current) {
      void inv.reject({ statusCode: 486 });
      return;
    }
    session.current = inv;
    setCall({
      from: inv.remoteIdentity.uri.user ?? "",
      name: inv.remoteIdentity.displayName ?? "",
      queue: inv.request.getHeader("X-Santralio-Queue") ?? null,
      did: inv.request.getHeader("X-Santralio-DID") ?? null,
      startedAt: null,
    });
    setMuted(false);
    setPhase("ringing");
    ringer.current.start();
    inv.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        ringer.current.stop();
        attachRemoteAudio(inv);
        setCall((c) => (c ? { ...c, startedAt: Date.now() } : c));
        setPhase("talking");
      }
      if (state === SessionState.Terminated) {
        ringer.current.stop();
        session.current = null;
        setCall(null);
        setPhase((p) => (p === "error" ? p : "ready"));
      }
    });
  };

  const start = async () => {
    setError("");
    setPhase("connecting");
    ringer.current.unlock();
    try {
      // Mikrofon izni şimdi istenir; arama gelince beklemeden açılabilsin.
      const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.getTracks().forEach((t) => t.stop());
      const a = await api.agent();
      setAgent(a);
      setPaused(a.paused);
      const userAgent = new UserAgent({
        uri: UserAgent.makeURI(a.sip.uri),
        transportOptions: { server: a.sip.wsServer },
        authorizationUsername: a.sip.username,
        authorizationPassword: a.sip.password,
        displayName: a.displayName || a.extension,
        logLevel: "warn",
        sessionDescriptionHandlerFactoryOptions: { iceGatheringTimeout: 1000, peerConnectionConfiguration: { iceServers: [] } },
        delegate: {
          onInvite,
          onDisconnect: (err) => {
            if (err) {
              setError("Santral bağlantısı koptu. Yeniden bağlanmak için “Mesaiye başla”ya basın.");
              setPhase("error");
            }
          },
        },
      });
      ua.current = userAgent;
      await userAgent.start();
      const reg = new Registerer(userAgent, { expires: 300 });
      registerer.current = reg;
      reg.stateChange.addListener((s) => {
        if (s === RegistererState.Registered) setPhase((p) => (p === "connecting" || p === "error" ? "ready" : p));
        if (s === RegistererState.Unregistered && ua.current) setPhase((p) => (p === "ready" ? "connecting" : p));
      });
      await reg.register({
        requestDelegate: {
          onReject: (r) => {
            setError(`Santral kaydı reddedildi (${r.message.statusCode}).`);
            setPhase("error");
          },
        },
      });
    } catch (e) {
      setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Mikrofon izni verilmedi." : e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  const stop = async () => {
    await session.current?.dispose().catch(() => {});
    await registerer.current?.unregister().catch(() => {});
    await ua.current?.stop().catch(() => {});
    ua.current = null;
    registerer.current = null;
    setPhase("idle");
  };

  const answer = () => {
    const s = session.current;
    if (s instanceof Invitation) {
      void s.accept({ sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    }
  };

  const hangup = () => {
    const s = session.current;
    if (!s) return;
    if (s instanceof Invitation && s.state === SessionState.Initial) void s.reject();
    else if (s.state === SessionState.Established) void s.bye();
    else void s.dispose();
  };

  const toggleMute = () => {
    const sdh = session.current?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
    for (const s of sdh?.peerConnection?.getSenders() ?? []) if (s.track) s.track.enabled = muted;
    setMuted(!muted);
  };

  const togglePause = async () => {
    try {
      const r = await api.setPause(!paused);
      setPaused(r.paused);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const online = phase === "ready" || phase === "ringing" || phase === "talking";
  return (
    <div className="desk">
      <div className="card">
        <div className="row spread">
          <div>
            <h2>Temsilci masası</h2>
            <p className="muted small">
              {agent ? `Dahili ${agent.extension}${agent.queues.length ? ` · Kuyruklar: ${agent.queues.map(QUEUE_LABEL).join(", ")}` : ""}` : "Bağlı değil"}
            </p>
          </div>
          <span className={`badge ${online ? (paused ? "off" : "ok") : "off"}`}>
            {online ? (paused ? "Molada" : "Müsait") : phase === "connecting" ? "Bağlanıyor…" : "Çevrimdışı"}
          </span>
        </div>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          {!online ? (
            <button onClick={start} disabled={phase === "connecting"}>
              Mesaiye başla
            </button>
          ) : (
            <>
              <button className={paused ? "" : "ghost"} onClick={togglePause} disabled={phase !== "ready"}>
                {paused ? "Müsait ol" : "Molaya çık"}
              </button>
              <button className="ghost" onClick={stop} disabled={phase !== "ready"}>
                Mesaiyi bitir
              </button>
            </>
          )}
        </div>
        {online && paused && <p className="muted small">Moladayken kuyruktan arama gelmez.</p>}
      </div>

      {call && (
        <div className={`card call ${phase}`}>
          <p className="muted small">{phase === "ringing" ? "Gelen arama" : `Görüşmede · ${duration(call.startedAt, now)}`}</p>
          <p className="caller mono">{call.from || "Gizli numara"}</p>
          {call.name && call.name !== call.from && <p>{call.name}</p>}
          <p className="small">
            {call.queue && <>Kuyruk: {QUEUE_LABEL(call.queue)}</>}
            {call.queue && call.did && " · "}
            {call.did && <>Aranan: {call.did}</>}
          </p>
          <div className="actions">
            {phase === "ringing" && <button onClick={answer}>Aç</button>}
            {phase === "talking" && (
              <button className="ghost" onClick={toggleMute}>
                {muted ? "Sesi aç" : "Sessize al"}
              </button>
            )}
            <button className="danger" onClick={hangup}>
              {phase === "ringing" ? "Reddet" : "Kapat"}
            </button>
          </div>
        </div>
      )}
      <audio ref={audio} autoPlay />
    </div>
  );
}
