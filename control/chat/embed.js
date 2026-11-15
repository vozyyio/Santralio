/* Santralio web sohbeti. Kullanım: <script src="https://api.<alan>/api/chat/embed.js" data-key="wk_..." async></script> */
(function () {
  var s = document.currentScript;
  var key = s && s.getAttribute("data-key");
  if (!key || window.__santralioChat) return;
  window.__santralioChat = 1;
  var base = new URL(s.src).origin;
  var f = document.createElement("iframe");
  f.src = base + "/api/chat/w/" + encodeURIComponent(key);
  f.title = "Canlı destek";
  var st = f.style;
  var closed = function () {
    st.right = "12px"; st.bottom = "12px"; st.width = "84px"; st.height = "84px"; st.borderRadius = "0";
  };
  st.position = "fixed"; st.border = "0"; st.zIndex = "2147483000"; st.background = "transparent"; st.colorScheme = "normal"; st.maxWidth = "100%"; st.maxHeight = "100%";
  closed();
  window.addEventListener("message", function (e) {
    if (e.origin !== base || e.source !== f.contentWindow) return;
    var d = e.data || {};
    if (d.type !== "santralio-chat") return;
    if (!d.open) return closed();
    if (window.innerWidth < 520) { st.right = "0"; st.bottom = "0"; st.width = "100%"; st.height = "100%"; }
    else { st.right = "12px"; st.bottom = "12px"; st.width = "400px"; st.height = "min(660px, calc(100vh - 24px))"; }
  });
  var add = function () { document.body.appendChild(f); };
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();
