// Santralio web sohbeti penceresi (iframe içinde). Mesajlar textContent ile yazılır; HTML yorumlanmaz.
(function () {
  var b = document.body;
  var key = b.getAttribute("data-key");
  var cfg = JSON.parse(b.getAttribute("data-config") || "{}");
  var api = "/api/chat/w/" + encodeURIComponent(key);
  var token = null;
  var busy = false;
  var done = false;
  document.documentElement.style.setProperty("--brand", cfg.color || "#1d6fe8");

  var $ = function (s) { return document.querySelector(s); };
  var log = $(".log"), input = $("textarea"), send = $("form button");
  $(".head strong").textContent = cfg.title || "Canlı destek";
  $(".head span").textContent = cfg.company && cfg.company !== cfg.title ? cfg.company + " · yapay zekâ asistanı" : "Yapay zekâ asistanı";

  var tell = function (open) { try { parent.postMessage({ type: "santralio-chat", open: open }, "*"); } catch (e) {} };
  var el = function (tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  var scroll = function () { log.scrollTop = log.scrollHeight; };
  var add = function (cls, text) { log.appendChild(el("div", "msg " + cls, text)); scroll(); };
  var safeUrl = function (u) { try { var x = new URL(u); return x.protocol === "https:" || (x.protocol === "http:" && x.hostname === "localhost") ? x.href : null; } catch (e) { return null; } };

  // +902526120000 -> +90 252 612 00 00
  var pretty = function (n) { var m = /^\+90(\d{3})(\d{3})(\d{2})(\d{2})$/.exec(n); return m ? "+90 " + m[1] + " " + m[2] + " " + m[3] + " " + m[4] : n; };
  function contact(c) {
    if (!c || (!c.phone && !c.whatsapp)) return;
    var row = el("div", "actions");
    if (c.phone) { var a = el("a", "btn ghost", "Ara: " + pretty(c.phone)); a.href = "tel:" + c.phone; row.appendChild(a); }
    if (c.whatsapp) { var w = el("a", "btn ghost", "WhatsApp"); w.href = "https://wa.me/" + c.whatsapp.replace(/\D/g, ""); w.target = "_blank"; w.rel = "noopener noreferrer"; row.appendChild(w); }
    log.appendChild(row); scroll();
  }
  function booking(r) {
    var c = el("div", "card");
    c.appendChild(el("small", null, "Rezervasyon numaranız"));
    c.appendChild(el("div", "ref", r.reference));
    var u = r.paymentUrl && safeUrl(r.paymentUrl);
    if (u) { var a = el("a", "btn", "Ödeme yap"); a.href = u; a.target = "_blank"; a.rel = "noopener noreferrer"; c.appendChild(a); c.appendChild(el("small", null, "Ödeme güvenli ödeme sayfasında yapılır; kart bilginiz bize ulaşmaz.")); }
    log.appendChild(c); scroll();
  }
  function finish() {
    done = true; input.disabled = true; send.disabled = true;
    input.placeholder = "Sohbet sona erdi";
    var n = el("button", "btn ghost", "Yeni sohbet");
    n.type = "button";
    n.onclick = function () { token = null; done = false; log.textContent = ""; input.disabled = false; input.placeholder = "Mesajınızı yazın…"; begin(); };
    var row = el("div", "actions"); row.appendChild(n); log.appendChild(row); scroll();
  }
  function post(path, body) {
    return fetch(api + path, { method: "POST", credentials: "omit", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || "Bağlantı sorunu"); return j; }); });
  }
  function begin() {
    add("bot", cfg.greeting || "Merhaba, nasıl yardımcı olabilirim?");
    input.focus();
  }
  function ensure() {
    if (token) return Promise.resolve(token);
    var page = ""; try { page = document.referrer || ""; } catch (e) {}
    return post("/start", { page: page }).then(function (r) { token = r.token; return token; });
  }
  function submit(text) {
    if (busy || done || !text) return;
    busy = true; send.disabled = true;
    add("me", text);
    var t = el("div", "typing"); t.appendChild(el("i")); t.appendChild(el("i")); t.appendChild(el("i")); t.setAttribute("aria-label", "Yazıyor");
    log.appendChild(t); scroll();
    ensure()
      .then(function (tk) { return post("/message", { token: tk, text: text }); })
      .then(function (r) {
        t.remove();
        add("bot", r.reply);
        if (r.booking) booking(r.booking);
        if (r.contact) contact(r.contact);
        if (r.status !== "open") finish();
      })
      .catch(function (e) { t.remove(); add("err", e.message || "Mesaj gönderilemedi"); })
      .then(function () { busy = false; if (!done) { send.disabled = !input.value.trim(); input.focus(); } });
  }

  $(".launcher").onclick = function () { b.classList.add("open"); tell(true); if (!log.childElementCount) begin(); else input.focus(); };
  $(".head button").onclick = function () { b.classList.remove("open"); tell(false); };
  $("form").onsubmit = function (e) { e.preventDefault(); var v = input.value.trim(); input.value = ""; input.style.height = ""; submit(v); };
  input.oninput = function () { send.disabled = busy || !input.value.trim(); input.style.height = ""; input.style.height = Math.min(input.scrollHeight, 120) + "px"; };
  input.onkeydown = function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("form").requestSubmit(); } };
  document.onkeydown = function (e) { if (e.key === "Escape" && b.classList.contains("open")) $(".head button").click(); };
})();
