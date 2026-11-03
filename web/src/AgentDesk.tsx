// Santralio temsilci masası: tarayıcıdan arama alma (SIP-over-WebSocket + WebRTC).
// Temsilci "Mesaiye başla" ile bağlanır: mikrofon izni alınır, SIP kaydı yapılır.
// Kuyruktan gelen arama tarayıcıda çalar; aç, sessize al, kapat. Müsait/molada durumu kuyruğa yansır.

import { useEffect, useRef, useState } from "react";
import { Invitation, Inviter, Registerer, RegistererState, SessionState, UserAgent, Web, type Session } from "sip.js";
import { api, type Agent } from "./api";
import { CallerPanel } from "./Crm";

type Phase = "idle" | "connecting" | "ready" | "ringing" | "calling" | "talking" | "error";
type Call = { from: string; name: string; queue: string | null; did: string | null; startedAt: number | null; callid: string | null };

const QUEUE_LABEL = (q: string | null) => (q ? q.charAt(0).toLocaleUpperCase("tr") + q.slice(1) : null);

// Sunucudaki normalizeNumber ile aynı kural: "+90 532…" / "532…" -> "0532…", "+49…" -> "0049…".
function normalizeNumber(input: string): string | null {
  let n = input.replace(/[\s().-]/g, "");
  if (n.startsWith("+")) n = "00" + n.slice(1);
  if (!/^[0-9]{4,20}$/.test(n)) return null;
  if (n.startsWith("0090")) n = "0" + n.slice(4);
  else if (n.startsWith("90") && n.length === 12) n = "0" + n.slice(2);
  else if (/^[2-5][0-9]{9}$/.test(n)) n = "0" + n;
  return n;
}

// Santralin dış aramayı reddetme nedenleri (Hangup nedeni -> SIP yanıtı).
const OUT_ERRORS: Record<number, string> = {
  403: "Bu numara dış arama politikası dışında ya da günlük dış arama sınırı doldu.",
  404: "Numara bulunamadı.",
  486: "Aranan numara meşgul.",
  503: "Eş zamanlı dış arama sınırı dolu; biraz sonra tekrar deneyin.",
};

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
  const [directory, setDirectory] = useState<{ queues: { name: string; number: string | null }[]; extensions: { number: string; name: string }[] } | null>(null);
  const [transferOpen, setTransferOpen] = useState<"blind" | "consult" | null>(null);
  const [held, setHeld] = useState(false);
  // Danışmalı aktarma: arayan beklerken temsilcinin açtığı ikinci görüşme.
  const [consultInfo, setConsultInfo] = useState<{ label: string; state: "calling" | "talking" } | null>(null);
  const [focus, setFocus] = useState<"caller" | "consult">("caller");
  const consult = useRef<Session | null>(null);
  const transferring = useRef(false);
  const [consultDial, setConsultDial] = useState("");
  const consultLabel = useRef("");
  const [dial, setDial] = useState("");
  // Görüşme bitince müşteri paneli, not kaydedilene ya da kapatılana kadar açık kalır.
  const [lastCall, setLastCall] = useState<Call | null>(null);
  const callRef = useRef<Call | null>(null);
  useEffect(() => {
    callRef.current = call;
  }, [call]);
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
    setLastCall(null);
    setCall({
      from: inv.remoteIdentity.uri.user ?? "",
      name: inv.remoteIdentity.displayName ?? "",
      queue: inv.request.getHeader("X-Santralio-Queue") ?? null,
      did: inv.request.getHeader("X-Santralio-DID") ?? null,
      callid: inv.request.getHeader("X-Santralio-CallId") ?? null,
      startedAt: null,
    });
    setMuted(false);
    setPhase("ringing");
    ringer.current.start();
    watch(inv);
  };

  // Gelen ve giden görüşmenin ortak durum takibi.
  const watch = (s: Session) => {
    s.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        ringer.current.stop();
        attachRemoteAudio(s);
        setCall((c) => (c ? { ...c, startedAt: Date.now() } : c));
        setPhase("talking");
      }
      if (state === SessionState.Terminated) {
        ringer.current.stop();
        if (callRef.current) setLastCall(callRef.current);
        setHeld(false);
        setTransferOpen(null);
        // Danışma sırasında arayan kapattıysa (aktarma değil), danışma görüşmesi normal görüşmeye döner.
        if (consult.current && !transferring.current) {
          const c = consult.current;
          consult.current = null;
          session.current = c;
          setCall({ from: consultLabel.current, name: "", queue: null, did: null, callid: null, startedAt: Date.now() });
          setConsultInfo(null);
          setFocus("caller");
          void setHold(c, false).then(() => attachRemoteAudio(c));
          return;
        }
        session.current = null;
        setCall(null);
        setPhase((p) => (p === "error" ? p : "ready"));
      }
    });
  };

  // Beklet / devam: görüşme içi yeniden davet (re-INVITE). Beklemedeki tarafa santral bekleme müziği çalar.
  const setHold = (s: Session, hold: boolean) =>
    s.invite({ sessionDescriptionHandlerModifiers: hold ? [Web.holdModifier] : [] }).then(
      () => true,
      (e) => {
        setError(`Bekletme başarısız: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      },
    );

  const toggleHold = async () => {
    const s = session.current;
    if (!s || s.state !== SessionState.Established || consult.current) return;
    if (await setHold(s, !held)) setHeld(!held);
  };

  // Danış: arayan beklemeye alınır, hedef aranır.
  const startConsult = async (target: string, label: string) => {
    const main = session.current;
    const uri = UserAgent.makeURI(`sip:${target}@${agent!.sip.domain}`);
    if (!ua.current || !main || main.state !== SessionState.Established || consult.current || !uri) return;
    setTransferOpen(null);
    setError("");
    if (!held && !(await setHold(main, true))) return;
    setHeld(true);
    const inv = new Inviter(ua.current, uri, { earlyMedia: true, sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } } });
    consult.current = inv;
    transferring.current = false;
    consultLabel.current = label;
    setConsultInfo({ label, state: "calling" });
    setFocus("consult");
    inv.stateChange.addListener((state) => {
      if (state === SessionState.Established) {
        attachRemoteAudio(inv);
        setConsultInfo((c) => (c ? { ...c, state: "talking" } : c));
      }
      if (state === SessionState.Terminated && consult.current === inv) {
        // Danışılan kapattı ya da vazgeçildi: arayana geri dönülür.
        consult.current = null;
        setConsultInfo(null);
        setFocus("caller");
        const m = session.current;
        if (m && m.state === SessionState.Established && !transferring.current) {
          void setHold(m, false).then((ok) => {
            if (ok) setHeld(false);
            attachRemoteAudio(m);
          });
        }
      }
    });
    void inv
      .invite({
        requestDelegate: {
          onProgress: () => attachRemoteAudio(inv),
          onReject: (r) => setError(OUT_ERRORS[r.message.statusCode ?? 0] ?? `Danışma araması kurulamadı (${r.message.statusCode ?? ""}).`),
        },
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  // Aktarımı tamamla: arayan danışılan kişiye bağlanır (REFER + Replaces), temsilcinin iki bağlantısı da kapanır.
  const completeTransfer = () => {
    const main = session.current;
    const c = consult.current;
    if (!main || !c || c.state !== SessionState.Established) return;
    transferring.current = true;
    void main.refer(c).catch((e) => {
      transferring.current = false;
      setError(`Aktarma başarısız: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  const cancelConsult = () => {
    const c = consult.current;
    if (!c) return;
    if (c instanceof Inviter && c.state !== SessionState.Established) void c.cancel();
    else if (c.state === SessionState.Established) void c.bye();
    else void c.dispose();
  };

  // Arayan ile danışılan arasında geçiş: konuşulmayan taraf beklemeye alınır.
  const swap = async () => {
    const main = session.current;
    const c = consult.current;
    if (!main || !c || c.state !== SessionState.Established) return;
    if (focus === "consult") {
      if (!(await setHold(c, true)) || !(await setHold(main, false))) return;
      setHeld(false);
      attachRemoteAudio(main);
      setFocus("caller");
    } else {
      if (!(await setHold(main, true)) || !(await setHold(c, false))) return;
      setHeld(true);
      attachRemoteAudio(c);
      setFocus("consult");
    }
  };

  // Dış arama. Numara santralde dış arama politikasına göre denetlenir; tarayıcıdaki kontrol yalnızca biçim içindir.
  const placeCall = () => {
    const n = normalizeNumber(dial);
    const uri = n ? UserAgent.makeURI(`sip:${n}@${agent!.sip.domain}`) : undefined;
    if (!ua.current || !uri || session.current) {
      if (!n) setError("Numara geçersiz.");
      return;
    }
    setError("");
    const inv = new Inviter(ua.current, uri, {
      earlyMedia: true,
      sessionDescriptionHandlerOptions: { constraints: { audio: true, video: false } },
    });
    session.current = inv;
    setLastCall(null);
    setCall({ from: n!, name: "", queue: "out", did: null, startedAt: null, callid: null });
    setMuted(false);
    setPhase("calling");
    watch(inv);
    void inv
      .invite({
        requestDelegate: {
          // Karşı tarafın çalma sesi (erken medya) duyulsun.
          onProgress: () => attachRemoteAudio(inv),
          onReject: (r) => {
            const code = r.message.statusCode ?? 0;
            setError(OUT_ERRORS[code] ?? `Arama kurulamadı (${code} ${r.message.reasonPhrase ?? ""}).`);
          },
        },
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
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
      api.directory().then(setDirectory).catch(() => setDirectory(null));
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
    if (s instanceof Inviter && s.state !== SessionState.Established) void s.cancel();
    else if (s instanceof Invitation && s.state === SessionState.Initial) void s.reject();
    else if (s.state === SessionState.Established) void s.bye();
    else void s.dispose();
  };

  // Aktarma (kör): arayan seçilen kuyruğa ya da dahiliye gider, temsilcinin bağlantısı kapanır.
  // Hedefler kiracının kendi iç numaralarıdır; santral bunları yalnızca kendi kiracısında çözer.
  const transfer = (target: string) => {
    const s = session.current;
    const uri = UserAgent.makeURI(`sip:${target}@${agent!.sip.domain}`);
    if (!s || !uri || s.state !== SessionState.Established) return;
    setTransferOpen(null);
    void s.refer(uri).catch((e) => setError(`Aktarma başarısız: ${e instanceof Error ? e.message : String(e)}`));
  };

  // Sessize al: açık bütün görüşmelerde mikrofon kapanır.
  const toggleMute = () => {
    for (const sess of [session.current, consult.current]) {
      const sdh = sess?.sessionDescriptionHandler as Web.SessionDescriptionHandler | undefined;
      for (const s of sdh?.peerConnection?.getSenders() ?? []) if (s.track) s.track.enabled = muted;
    }
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

  const online = phase === "ready" || phase === "ringing" || phase === "calling" || phase === "talking";
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
        {online && agent?.outbound && (
          <>
            <form
              className="dialer"
              onSubmit={(e) => {
                e.preventDefault();
                placeCall();
              }}
            >
              <input
                type="tel"
                inputMode="tel"
                placeholder="Numara (ör. 0532 123 45 67 ya da +49 …)"
                value={dial}
                onChange={(e) => setDial(e.target.value)}
                disabled={phase !== "ready"}
                aria-label="Aranacak numara"
              />
              <button disabled={phase !== "ready" || !dial.trim()}>Ara</button>
            </form>
            <p className="muted small">Aranabilen: {agent.outbound.join(", ")}. Karşı tarafa şirketin numarası görünür.</p>
          </>
        )}
      </div>

      {call && (
        <div className={`card call ${phase}`}>
          <p className="muted small">
            {phase === "ringing" ? "Gelen arama" : phase === "calling" ? "Aranıyor…" : `Görüşmede · ${duration(call.startedAt, now)}`}
          </p>
          <p className="caller mono">{call.from || "Gizli numara"}</p>
          {call.name && call.name !== call.from && <p>{call.name}</p>}
          <p className="small">
            {call.queue === "out" ? <>Dış arama</> : call.queue && <>Kuyruk: {QUEUE_LABEL(call.queue)}</>}
            {call.queue && call.did && " · "}
            {call.did && <>Aranan: {call.did}</>}
          </p>
          <div className="actions">
            {phase === "ringing" && <button onClick={answer}>Aç</button>}
            {phase === "talking" && !consultInfo && (
              <button className="ghost" onClick={toggleHold}>
                {held ? "Devam et" : "Beklet"}
              </button>
            )}
            {phase === "talking" && (
              <button className="ghost" onClick={toggleMute}>
                {muted ? "Sesi aç" : "Sessize al"}
              </button>
            )}
            {phase === "talking" && directory && !consultInfo && (
              <>
                <button className="ghost" onClick={() => setTransferOpen(transferOpen === "blind" ? null : "blind")}>
                  Aktar
                </button>
                <button className="ghost" onClick={() => setTransferOpen(transferOpen === "consult" ? null : "consult")}>
                  Danış
                </button>
              </>
            )}
            {!consultInfo && (
              <button className="danger" onClick={hangup}>
                {phase === "ringing" ? "Reddet" : phase === "calling" ? "Vazgeç" : "Kapat"}
              </button>
            )}
          </div>
          {held && !consultInfo && <p className="muted small">Arayan beklemede; bekleme müziği dinliyor.</p>}
          {transferOpen === "blind" && directory && (
            <div className="transfer">
              <p className="muted small">Doğrudan aktar (arayan seçilen yere geçer, sizin bağlantınız kapanır):</p>
              <div className="row">
                {directory.queues.map((q) => (
                  <button key={q.name} className="ghost" onClick={() => transfer(`q-${q.name.replace(/_/g, "-")}`)}>
                    {QUEUE_LABEL(q.name)}
                  </button>
                ))}
              </div>
              <div className="row">
                {directory.extensions.map((e) => (
                  <button key={e.number} className="ghost" onClick={() => transfer(e.number)}>
                    {e.number}
                    {e.name ? ` · ${e.name}` : ""}
                  </button>
                ))}
              </div>
            </div>
          )}
          {transferOpen === "consult" && directory && (
            <div className="transfer">
              <p className="muted small">Danış: arayan beklemeye alınır, seçtiğiniz kişiyle önce siz konuşursunuz; sonra aktarımı tamamlarsınız ya da arayana dönersiniz.</p>
              <div className="row">
                {directory.extensions.map((e) => (
                  <button key={e.number} className="ghost" onClick={() => startConsult(e.number, `${e.number}${e.name ? ` · ${e.name}` : ""}`)}>
                    {e.number}
                    {e.name ? ` · ${e.name}` : ""}
                  </button>
                ))}
              </div>
              {agent?.outbound && (
                <form
                  className="dialer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = normalizeNumber(consultDial);
                    if (!n) return setError("Numara geçersiz.");
                    void startConsult(n, n);
                    setConsultDial("");
                  }}
                >
                  <input type="tel" placeholder="Dış numaraya danış" value={consultDial} onChange={(e) => setConsultDial(e.target.value)} />
                  <button className="ghost" disabled={!consultDial.trim()}>
                    Ara
                  </button>
                </form>
              )}
            </div>
          )}
          {consultInfo && (
            <div className="transfer consult">
              <p>
                <strong>Danışılıyor: {consultInfo.label}</strong>{" "}
                <span className="muted small">
                  {consultInfo.state === "calling" ? "· çalıyor…" : focus === "consult" ? "· görüşüyorsunuz, arayan beklemede" : "· beklemede, arayanla görüşüyorsunuz"}
                </span>
              </p>
              <div className="actions">
                <button disabled={consultInfo.state !== "talking"} onClick={completeTransfer}>
                  Aktarımı tamamla
                </button>
                <button className="ghost" disabled={consultInfo.state !== "talking"} onClick={swap}>
                  {focus === "consult" ? "Arayana dön" : "Danışılana dön"}
                </button>
                <button className="danger" onClick={cancelConsult}>
                  Vazgeç
                </button>
              </div>
            </div>
          )}
        </div>
      )}
      {agent && agent.crm && (call ?? lastCall) && (call ?? lastCall)!.from && (
        <div className="card">
          <div className="row spread">
            <h3>{call ? "Arayan" : "Görüşme sonrası"}</h3>
            {!call && (
              <button className="ghost" onClick={() => setLastCall(null)}>
                Kapat
              </button>
            )}
          </div>
          <CallerPanel
            prefix={agent.tenant}
            phone={(call ?? lastCall)!.from}
            callid={(call ?? lastCall)!.callid}
            direction={(call ?? lastCall)!.queue === "out" ? "out" : "in"}
          />
        </div>
      )}
      <audio ref={audio} autoPlay />
    </div>
  );
}
