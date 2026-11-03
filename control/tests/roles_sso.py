#!/usr/bin/env python3
"""Santralio: roller, yetkiler ve üç adres arasında tek giriş (SSO) testleri, canlı ve Cloudflare üzerinden.

Gerekenler (ortam değişkenleri; şifreler komut satırında görünmez):
  PREFIX            : kiracı (ör. t1)
  ADMIN_EMAIL/PASS  : kiracının "Patron" rolündeki kullanıcısı
  AGENT_EMAIL       : kiracının "Temsilci" rolündeki, dahilisi olan bir kullanıcısı (şifresi testte sıfırlanır)
Test bir rol ("Test Rapor") ve bir kullanıcı (test-rapor@santralio.invalid) açar; sonunda kullanıcıları kapatır.
"""
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.request

DOMAIN = os.environ.get("BASE_DOMAIN", "santralio.site")
PANEL, CRM, AGENT = (f"https://{h}.{DOMAIN}" for h in ("panel", "crm", "agent"))
P = os.environ["PREFIX"]
fails = 0


class Client:
    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def call(self, method, url, body=None, origin=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("x-santralio-client", "web")
        req.add_header("user-agent", "santralio-test")
        req.add_header("origin", origin or url.split("/api")[0])
        if data is not None:
            req.add_header("content-type", "application/json")
        try:
            with self.op.open(req, timeout=60) as r:
                raw = r.read()
                return r.status, (json.loads(raw) if r.headers.get_content_type() == "application/json" else raw)
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b"{}")

    def login(self, host, email, password):
        s, r = self.call("POST", f"{host}/api/login", {"email": email, "password": password})
        assert s == 200, (email, s, r)


def check(desc, ok, extra=""):
    global fails
    print(f"  {'geçti' if ok else 'KALDI'} : {desc}{'' if ok else '  ' + str(extra)}")
    fails += 0 if ok else 1


T = f"/api/tenants/{P}"
admin = Client()
print("Tek giriş: panelde giriş, CRM ve temsilci adreslerinde aynı oturum")
admin.login(PANEL, os.environ["ADMIN_EMAIL"], os.environ["ADMIN_PASS"])
cookie = next(c for c in admin.jar)
check("çerez üst alan adında (.santralio.site), HttpOnly", cookie.domain == f".{DOMAIN}" and cookie.has_nonstandard_attr("HttpOnly"), cookie.domain)
s, me = admin.call("GET", f"{CRM}/api/me")
check("crm adresinde yeniden giriş istemeden /api/me", s == 200 and me.get("roleName") == "Patron", (s, me))
check("Patron (dahilisiz) panel ve crm açabilir, temsilci masası dahili ister", me.get("apps") == ["panel", "crm"], me.get("apps"))

print("Roller: ekrandan tanımlanan rol ve yetki")
s, roles = admin.call("GET", f"{PANEL}{T}/roles")
names = [r["name"] for r in roles]
check("başlangıç rolleri var", all(n in names for n in ("Patron", "Müdür", "Süpervizör", "Temsilci")), names)
role = next((r for r in roles if r["name"] == "Test Rapor"), None)
if role is None:
    s, r = admin.call("POST", f"{PANEL}{T}/roles", {"name": "Test Rapor", "permissions": ["reports.view"]})
    check("yeni rol açıldı", s == 200, r)
    role_id = r["id"]
else:
    role_id = role["id"]
    admin.call("PUT", f"{PANEL}{T}/roles/{role_id}", {"name": "Test Rapor", "permissions": ["reports.view"]})
s, r = admin.call("POST", f"{PANEL}{T}/roles", {"name": "Test Rapor", "permissions": []})
check("aynı adla ikinci rol açılamaz", s == 400, r)
s, r = admin.call("POST", f"{PANEL}{T}/roles", {"name": "X", "permissions": ["her.sey"]})
check("katalogda olmayan yetki reddedilir", s == 400, r)
patron = next(r for r in roles if r["name"] == "Patron")
s, r = admin.call("PUT", f"{PANEL}{T}/roles/{patron['id']}", {"name": "Patron", "permissions": ["settings.manage"]})
check("kendi rolünden personel yönetimi kaldırılamaz", s == 400, r)
s, r = admin.call("DELETE", f"{PANEL}{T}/roles/{patron['id']}")
check("personeli olan rol silinemez", s == 400, r)

print("Yalnızca rapor yetkisi olan kullanıcı")
email = "test-rapor@santralio.invalid"
s, users = admin.call("GET", f"{PANEL}{T}/users")
if any(u["email"] == email for u in users):
    admin.call("PUT", f"{PANEL}{T}/users/{email}", {"disabled": False, "roleId": role_id})
    s, r = admin.call("POST", f"{PANEL}{T}/users/{email}/reset-password")
else:
    s, r = admin.call("POST", f"{PANEL}{T}/users", {"email": email, "name": "Test Rapor", "roleId": role_id, "extension": None})
check("rol seçilerek, dahilisiz personel açıldı", s == 200 and r.get("temporaryPassword"), r)
rep = Client()
rep.login(CRM, email, r["temporaryPassword"])
s, me = rep.call("GET", f"{CRM}/api/me")
check("açabildiği adres yalnızca crm", me.get("apps") == ["crm"], me.get("apps"))
check("raporlar açık", rep.call("GET", f"{CRM}{T}/reports/summary")[0] == 200)
for path, what in ((f"{T}/calls", "görüşmeler"), (T, "ayarlar"), (f"{T}/users", "personel"), (f"{T}/audit", "günlük"), (f"{T}/roles", "roller")):
    check(f"{what} kapalı (404)", rep.call("GET", f"{CRM}{path}")[0] == 404)
check("ayar değiştiremez (404)", rep.call("PUT", f"{CRM}{T}/recording", {"enabled": True})[0] == 404)
check("temsilci masası kapalı (403)", rep.call("GET", f"{AGENT}/api/agent")[0] == 403)

print("Temsilci: yalnızca kendi görüşmeleri")
agent_email = os.environ["AGENT_EMAIL"]
s, r = admin.call("POST", f"{PANEL}{T}/users/{agent_email}/reset-password")
ag = Client()
ag.login(AGENT, agent_email, r["temporaryPassword"])
s, me = ag.call("GET", f"{AGENT}/api/me")
check("temsilci crm ve agent açabilir, panel açamaz", me.get("apps") == ["crm", "agent"], me.get("apps"))
s, calls = ag.call("GET", f"{CRM}{T}/calls?from=2026-01-01&to=2026-12-31")
check("görüşme listesi yalnızca kendi dahilisinin", s == 200 and all(c["agent"] == me["extension"] for c in calls), (s, len(calls)))
check("kayıt bağlantısı yok (kayıt dinleme yetkisi yok)", all(c["recording"] is None for c in calls))
s, allcalls = admin.call("GET", f"{CRM}{T}/calls?from=2026-01-01&to=2026-12-31")
other = next((c for c in allcalls if c["recording"] and c["agent"] != me["extension"]), None)
if other:
    check("başkasının kaydı dinlenemez (404)", ag.call("GET", f"{CRM}{T}/recordings/{other['callid']}")[0] == 404)
check("ayarlar kapalı (404)", ag.call("GET", f"{PANEL}{T}")[0] == 404)
check("temsilci SIP bilgisi yalnızca agent yetkisiyle", ag.call("GET", f"{AGENT}/api/agent")[0] == 200)

print("Güvenlik")
s, r = admin.call("PUT", f"{PANEL}{T}/recording", {"enabled": False}, origin="https://kotu.example")
check("başka siteden değişiklik isteği reddedilir (CSRF, 403)", s == 403, (s, r))
for c in (admin, rep, ag):
    c.call("POST", f"{PANEL}/api/logout")
check("çıkıştan sonra oturum geçersiz", admin.call("GET", f"{CRM}/api/me")[0] == 401)

print()
print("Rol ve tek giriş testi geçti." if fails == 0 else f"Rol ve tek giriş testi: {fails} kontrol kaldı.")
sys.exit(1 if fails else 0)
