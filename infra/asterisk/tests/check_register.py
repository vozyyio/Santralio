#!/usr/bin/env python3
"""Santralio: bir dahilinin TLS (5061) üzerinden digest ile kayıt olabildiğini sınar.

Şifre komut satırından değil standart girdiden okunur:
  santralio ext secret t1 1001 | awk '/^ *şifre / {print $3}' | python3 -I check_register.py t1_1001
--expect-fail ile kaydın reddedilmesi beklenir (ör. başka bir dahilinin şifresi).
--wrong şifrenin sonuna bir karakter ekler ve reddedilmeyi bekler.
"""
import hashlib
import random
import re
import socket
import ssl
import sys

HOST = "sip.santralio.site"
PORT = 5061
user = sys.argv[1]
wrong = "--wrong" in sys.argv
expect_fail = wrong or "--expect-fail" in sys.argv
password = sys.stdin.read().strip() + ("x" if wrong else "")

ctx = ssl.create_default_context()
raw = socket.create_connection((HOST, PORT), timeout=5)
sock = ctx.wrap_socket(raw, server_hostname=HOST)
lip, lport = sock.getsockname()[:2]
callid = "%016x@santralio-test" % random.getrandbits(64)
tag = "%08x" % random.getrandbits(32)
uri = f"sip:{HOST};transport=tls"


def send(cseq, auth=None):
    lines = [
        f"REGISTER {uri} SIP/2.0",
        f"Via: SIP/2.0/TLS {lip}:{lport};branch=z9hG4bK{random.getrandbits(32):08x};rport",
        "Max-Forwards: 70",
        f"From: <sip:{user}@{HOST}>;tag={tag}",
        f"To: <sip:{user}@{HOST}>",
        f"Call-ID: {callid}",
        f"CSeq: {cseq} REGISTER",
        f"Contact: <sip:{user}@{lip}:{lport};transport=tls>",
        "Expires: 0" if expect_fail else "Expires: 60",
        "User-Agent: santralio-check",
    ]
    if auth:
        lines.append(auth)
    lines += ["Content-Length: 0", "", ""]
    sock.sendall("\r\n".join(lines).encode())
    while True:
        data = sock.recv(8192).decode(errors="replace")
        code = int(data.split(" ", 2)[1])
        if code >= 200:
            return code, data


code, resp = send(1)
if code != 401:
    print(f"beklenmeyen ilk yanıt: {code}")
    sys.exit(1)
challenge = re.search(r"^WWW-Authenticate: Digest (.*)$", resp, re.M | re.I).group(1)
params = dict(re.findall(r'(\w+)="?([^",]+)"?', challenge))
realm, nonce, qop = params["realm"], params["nonce"], params.get("qop")
ha1 = hashlib.md5(f"{user}:{realm}:{password}".encode()).hexdigest()
ha2 = hashlib.md5(f"REGISTER:{uri}".encode()).hexdigest()
auth = f'Authorization: Digest username="{user}", realm="{realm}", nonce="{nonce}", uri="{uri}", algorithm=MD5'
if qop:
    nc, cnonce = "00000001", "%08x" % random.getrandbits(32)
    response = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:auth:{ha2}".encode()).hexdigest()
    auth += f', qop=auth, nc={nc}, cnonce="{cnonce}"'
else:
    response = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()
auth += f', response="{response}"'
if "opaque" in params:
    auth += f', opaque="{params["opaque"]}"'
code, _ = send(2, auth)
print(f"{user} REGISTER ({'reddedilmeli' if expect_fail else 'kabul edilmeli'}) -> {code}")
ok = (code >= 400) if expect_fail else (code == 200)
sys.exit(0 if ok else 1)
