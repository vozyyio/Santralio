#!/usr/bin/env python3
"""Santralio: CRM uçtan uca testi (kart, numaradan bulma, not, sonuç kodu, izolasyon).

Ortam değişkenleri (şifreler komut satırında görünmez):
  A, A_EMAIL, A_PASS : test verisinin yazılacağı kiracı ve onun Patron kullanıcısı (ör. askıdaki sahte t2)
  B, B_EMAIL, B_PASS : başka bir kiracının Patron kullanıcısı (izolasyon kontrolü)
  R_EMAIL, R_PASS    : (isteğe bağlı) A kiracısında CRM yetkisi olmayan bir kullanıcı
Test, A kiracısına "TEST" adlı kartlar ve notlar yazar; silmez.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
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


def login(email, password):
    s, r = call("POST", "/api/login", body={"email": email, "password": password})
    assert s == 200, (email, s, r)
    return r["token"]


def check(desc, ok, extra=""):
    global fails
    print(f"  {'geçti' if ok else 'KALDI'} : {desc}{'' if ok else '  ' + str(extra)}")
    fails += 0 if ok else 1


ta = login(os.environ["A_EMAIL"], os.environ["A_PASS"])
tb = login(os.environ["B_EMAIL"], os.environ["B_PASS"])
TA = f"/api/tenants/{A}"

print("Kart")
s, found = call("GET", f"{TA}/contacts?q=05550000001", ta)
if found:
    cid = found[0]["id"]
    call("PUT", f"{TA}/contacts/{cid}", ta, {"name": "TEST Ayşe Yılmaz", "company": "TEST Otel", "phones": ["+90 555 000 00 01"], "tags": ["VIP"]})
else:
    s, r = call("POST", f"{TA}/contacts", ta, {"name": "TEST Ayşe Yılmaz", "company": "TEST Otel", "phones": ["+90 555 000 00 01"], "tags": ["VIP"]})
    check("kart açıldı", s == 200, r)
    cid = r["id"]
s, c = call("GET", f"{TA}/contacts/{cid}", ta)
check("telefon tek biçimde saklandı (05550000001)", c.get("phones") == ["05550000001"], c.get("phones"))
s, r = call("POST", f"{TA}/contacts", ta, {"name": "TEST İkinci", "phones": ["0555 000 00 01"]})
check("aynı numara ikinci karta eklenemez", s == 400 and "TEST Ayşe" in r.get("error", ""), r)
s, r = call("POST", f"{TA}/contacts", ta, {"name": "TEST Kötü", "phones": ["abc"]})
check("geçersiz telefon reddedilir", s == 400, r)

print("Numaradan kart (temsilci ekranı)")
for raw in ("905550000001", "0555 000 00 01", "+90 (555) 000-00-01"):
    s, r = call("GET", f"{TA}/lookup?phone={urllib.parse.quote(raw)}", ta)
    check(f"'{raw}' -> kart", s == 200 and r["contact"] and r["contact"]["id"] == cid, r)
s, r = call("GET", f"{TA}/lookup?phone=05559999999", ta)
check("kayıtsız numara -> kart yok", s == 200 and r["contact"] is None and r["phone"] == "05559999999", r)

print("Not ve sonuç kodu")
s, disp = call("GET", f"{TA}/dispositions", ta)
check("başlangıç sonuç kodları", {"Çözüldü", "Geri aranacak"} <= {d["name"] for d in disp}, disp)
geri = next(d["id"] for d in disp if d["name"] == "Geri aranacak")
s, r = call("POST", f"{TA}/notes", ta, {"phone": "0555 000 00 01", "dispositionId": geri, "note": "TEST: fiyat soracak", "followUpAt": "2026-12-01T10:30", "direction": "in"})
check("not kaydedildi (kart numaradan bulundu)", s == 200, r)
s, r = call("POST", f"{TA}/notes", ta, {"phone": "05550000001"})
check("boş not reddedilir", s == 400, r)
s, bdisp = call("GET", f"/api/tenants/{B}/dispositions", tb)
s, r = call("POST", f"{TA}/notes", ta, {"phone": "05550000001", "dispositionId": bdisp[0]["id"], "note": "x"})
check("başka kiracının sonuç kodu kullanılamaz", s == 400, r)
s, c = call("GET", f"{TA}/contacts/{cid}", ta)
check("not kart sayfasında", any(n["note"] == "TEST: fiyat soracak" and n["disposition"] == "Geri aranacak" for n in c["notes"]), c.get("notes"))
s, f = call("GET", f"{TA}/follow-ups", ta)
check("geri aramalarda görünüyor", any(x["contactId"] == cid and x["followUpAt"] == "2026-12-01 10:30" for x in f), f)

print("İzolasyon")
check(f"{B} yöneticisi {A} kartını göremez (404)", call("GET", f"{TA}/contacts/{cid}", tb)[0] == 404)
check(f"{B} yöneticisi {A} kart listesine erişemez (404)", call("GET", f"{TA}/contacts", tb)[0] == 404)
s, r = call("GET", f"/api/tenants/{B}/lookup?phone=05550000001", tb)
check(f"{B}'de aynı numara {A}'nın kartını açmaz", s == 200 and r["contact"] is None, r)
if os.environ.get("R_EMAIL"):
    tr = login(os.environ["R_EMAIL"], os.environ["R_PASS"])
    check("CRM yetkisi olmayan kartlara erişemez (404)", call("GET", f"{TA}/contacts", tr)[0] == 404)
    call("POST", "/api/logout", tr)

for t in (ta, tb):
    call("POST", "/api/logout", t)
print()
print("CRM testi geçti." if fails == 0 else f"CRM testi: {fails} kontrol kaldı.")
sys.exit(1 if fails else 0)
