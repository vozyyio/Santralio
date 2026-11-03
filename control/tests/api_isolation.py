#!/usr/bin/env python3
"""Santralio: yönetim API'sinin kiracı izolasyonunu canlı sınar.

Üç hesap gerekir (ortam değişkenleriyle verilir, şifreler komut satırında görünmez):
  A_EMAIL / A_PASS : kiracı A'nın yöneticisi (tenant_admin)
  B_EMAIL / B_PASS : kiracı B'nin yöneticisi (tenant_admin)
  G_EMAIL / G_PASS : kiracı A'nın temsilcisi (agent)
  A, B             : kiracı önekleri (ör. t1, t2)
Kullanım: env A=t1 B=t2 A_EMAIL=... python3 -I api_isolation.py
Yalnızca okuma yapar; tek yazma, A'nın bir menüsünü mevcut değerleriyle yeniden kaydetmektir.
"""
import json
import os
import sys
import urllib.error
import urllib.request

BASE = os.environ.get("API", "http://127.0.0.1:8090")
A, B = os.environ["A"], os.environ["B"]
fails = 0


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("content-type", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def check(desc, ok):
    global fails
    print(f"  {'geçti' if ok else 'KALDI'} : {desc}")
    fails += 0 if ok else 1


def login(prefix):
    s, r = call("POST", "/api/login", body={"email": os.environ[f"{prefix}_EMAIL"], "password": os.environ[f"{prefix}_PASS"]})
    assert s == 200, (prefix, s, r)
    return r["token"]


print("Giriş")
s, _ = call("POST", "/api/login", body={"email": os.environ["A_EMAIL"], "password": "yanlis-sifre-123"})
check("yanlış şifre -> 401", s == 401)
s, _ = call("POST", "/api/login", body={"email": "olmayan@santralio.invalid", "password": "yanlis-sifre-123"})
check("olmayan kullanıcı -> 401 (aynı yanıt)", s == 401)
ta, tb, tg = login("A"), login("B"), login("G")

print(f"{B} yöneticisi {A}'yı göremez")
s, r = call("GET", "/api/tenants", tb)
check(f"liste yalnızca {B}", s == 200 and [t["prefix"] for t in r] == [B])
s, _ = call("GET", f"/api/tenants/{A}", tb)
check(f"GET /api/tenants/{A} -> 404", s == 404)
s, _ = call("PUT", f"/api/tenants/{A}/menus/ana", tb, {"text": "ele geçirildi"})
check(f"{A} menüsünü değiştiremez -> 404", s == 404)
s, _ = call("POST", f"/api/tenants/{A}/extensions", tb, {"number": "1999"})
check(f"{A}'ya dahili ekleyemez -> 404", s == 404)
s, _ = call("GET", "/api/tenants/t999", tb)
check("olmayan kiracı da aynı yanıt (404)", s == 404)

print(f"{A} yöneticisi kendi kiracısını yönetir")
s, d = call("GET", f"/api/tenants/{A}", ta)
check(f"GET /api/tenants/{A} -> 200", s == 200 and d.get("prefix") == A)
raw = json.dumps(d)
check("yanıtta şifre ya da token alanı yok", not any(k in raw for k in ("secret", "password", "contact_token", "secret_enc")))
menu = next((m for m in d.get("menus", []) if m["name"] == "ana"), None)
if menu:
    s, r = call("PUT", f"/api/tenants/{A}/menus/ana", ta, {"text": "YARIM KALMAMALI", "options": {**menu["options"], "9": "queue:olmayan"}})
    check("başka/olmayan kuyruğa tuş bağlanamaz -> 400", s == 400)
    s, d2 = call("GET", f"/api/tenants/{A}", ta)
    after = next(m for m in d2["menus"] if m["name"] == "ana")
    check("reddedilen istek hiçbir şeyi değiştirmedi", after["prompt_text"] == menu["prompt_text"] and after["options"] == menu["options"])
    body = {"text": menu["prompt_text"], "invalidText": menu["invalid_text"], "defaultTarget": menu["default_target"],
            "timeoutS": menu["timeout_s"], "maxTries": menu["max_tries"], "options": menu["options"]}
    s, r = call("PUT", f"/api/tenants/{A}/menus/ana", ta, body)
    check("menüyü aynı değerlerle kaydeder ve uygular -> 200", s == 200)

print(f"{A} temsilcisi yönetemez")
s, r = call("GET", "/api/me", tg)
check("/api/me: temsilci, panel açamaz", s == 200 and r.get("role") == "tenant_user" and "panel" not in r.get("apps", []))
s, r = call("GET", "/api/tenants", tg)
check("kiracı listesi yalnızca kendi kiracısı", s == 200 and [t["prefix"] for t in r] == [A])
s, _ = call("GET", f"/api/tenants/{A}", tg)
check(f"{A} ayarlarını göremez -> 404", s == 404)
s, _ = call("PUT", f"/api/tenants/{A}/menus/ana", tg, {"text": "x"})
check("menü değiştiremez -> 404", s == 404)

print("Çıkış")
for t in (ta, tb, tg):
    call("POST", "/api/logout", t)
s, _ = call("GET", "/api/me", ta)
check("çıkıştan sonra belirteç geçersiz -> 401", s == 401)

print()
print("API izolasyon testi geçti." if fails == 0 else f"API izolasyon testi: {fails} kontrol kaldı.")
sys.exit(1 if fails else 0)
