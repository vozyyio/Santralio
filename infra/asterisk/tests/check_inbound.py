#!/usr/bin/env python3
"""Santralio: operatörden gelen aramayı sunucu içinden taklit eder.

Netgsm gibi kayıtlı trunk'lar INVITE'ı kayıttaki Contact adresine gönderir:
Request-URI'de kiracının contact token'ı, To başlığında aranan DID bulunur.

Kullanım (token ve DID argümandır, çıktıda token yazdırılmaz):
  python3 -I check_inbound.py <contact_token> <did> accept   # cevaplanmalı (200), sonra Asterisk kapatmalı
  python3 -I check_inbound.py <contact_token> <did> reject   # reddedilmeli (>= 400)

Ses gönderilmez; yalnızca sinyal yolu sınanır.
"""
import random
import socket
import sys

HOST, PORT = "127.0.0.1", 5060
PUBLIC = "116.203.184.30"
token, did, expect = sys.argv[1], sys.argv[2], sys.argv[3]
assert expect in ("accept", "reject")

sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
sock.settimeout(5)
sock.connect((HOST, PORT))
lip, lport = sock.getsockname()
callid = "%016x@santralio-inbound-test" % random.getrandbits(64)
ftag = "%08x" % random.getrandbits(32)
ruri = f"sip:{token}@{PUBLIC}:5060"
sdp = "\r\n".join([
    "v=0", f"o=- 1 1 IN IP4 {lip}", "s=-", f"c=IN IP4 {lip}", "t=0 0",
    f"m=audio {lport + 2} RTP/AVP 8 0", "a=rtpmap:8 PCMA/8000", "a=rtpmap:0 PCMU/8000", "a=sendrecv", "",
])


def send(lines, body=""):
    msg = "\r\n".join(lines + [f"Content-Length: {len(body)}", "", ""]) + body
    sock.send(msg.encode())


def header(data, name):
    for line in data.split("\r\n"):
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return ""


branch = "z9hG4bK%08x" % random.getrandbits(32)
base = [
    f"Via: SIP/2.0/UDP {lip}:{lport};branch={branch};rport",
    "Max-Forwards: 70",
    f"From: <sip:905551112233@sip.netgsm.com.tr>;tag={ftag}",
    f"To: <sip:{did}@sip.netgsm.com.tr>",
    f"Call-ID: {callid}",
]
send([f"INVITE {ruri} SIP/2.0", *base, "CSeq: 1 INVITE", f"Contact: <sip:905551112233@{lip}:{lport}>",
      "Content-Type: application/sdp", "User-Agent: santralio-inbound-test"], sdp)

final = None
codes = []
while final is None:
    data = sock.recv(65535).decode(errors="replace")
    if not data.startswith("SIP/2.0"):
        continue
    code = int(data.split(" ", 2)[1])
    codes.append(code)
    if code >= 200:
        final = (code, data)

code, data = final
to_hdr = header(data, "To")
if code >= 300:
    # Olumsuz yanıt: ACK aynı branch ile gönderilir.
    send([f"ACK {ruri} SIP/2.0", *base[:3], f"To: {to_hdr}", f"Call-ID: {callid}", "CSeq: 1 ACK"])
    print(f"DID {did}: yanıtlar {codes} -> reddedildi")
    sys.exit(0 if expect == "reject" else 1)

# 200 OK: ACK gönderilir, ardından Asterisk'in BYE'ı beklenir (kuyrukta müsait temsilci yoksa).
contact = header(data, "Contact").strip("<>").split(">")[0]
send([f"ACK {contact} SIP/2.0", f"Via: SIP/2.0/UDP {lip}:{lport};branch=z9hG4bK{random.getrandbits(32):08x};rport",
      "Max-Forwards: 70", f"From: <sip:905551112233@sip.netgsm.com.tr>;tag={ftag}", f"To: {to_hdr}",
      f"Call-ID: {callid}", "CSeq: 1 ACK"])
result = "cevaplandı"
try:
    while True:
        data = sock.recv(65535).decode(errors="replace")
        if data.startswith("BYE"):
            vias = [l for l in data.split("\r\n") if l.lower().startswith("via:")]
            send(["SIP/2.0 200 OK", *vias, f"From: {header(data, 'From')}", f"To: {header(data, 'To')}",
                  f"Call-ID: {callid}", f"CSeq: {header(data, 'CSeq')}"])
            result = "cevaplandı, Asterisk kapattı (BYE)"
            break
except socket.timeout:
    # Hâlâ bekliyorsa biz kapatırız.
    send([f"BYE {contact} SIP/2.0", f"Via: SIP/2.0/UDP {lip}:{lport};branch=z9hG4bK{random.getrandbits(32):08x};rport",
          "Max-Forwards: 70", f"From: <sip:905551112233@sip.netgsm.com.tr>;tag={ftag}", f"To: {to_hdr}",
          f"Call-ID: {callid}", "CSeq: 2 BYE"])
    result = "cevaplandı, test kapattı (BYE)"
print(f"DID {did}: yanıtlar {codes} -> {result}")
sys.exit(0 if expect == "accept" else 1)
