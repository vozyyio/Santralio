#!/usr/bin/env python3
"""Santralio: kimliği doğrulanmamış SIP isteklerinin reddedildiğini sınar.

Kullanım: python3 -I check_reject.py [hedef_ip] [port]
Her istek için yanıt kodu yazdırılır. 1xx/2xx (kabul) dönen istek başarısızdır.
"""
import random
import socket
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "116.203.184.30"
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 5060


def request(method, user, to_user, auth=None):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(3)
    sock.connect((HOST, PORT))
    lip, lport = sock.getsockname()
    branch = "z9hG4bK%08x" % random.getrandbits(32)
    tag = "%08x" % random.getrandbits(32)
    callid = "%016x@santralio-test" % random.getrandbits(64)
    uri = f"sip:{to_user}@{HOST}"
    lines = [
        f"{method} {uri} SIP/2.0",
        f"Via: SIP/2.0/UDP {lip}:{lport};branch={branch};rport",
        "Max-Forwards: 70",
        f"From: <sip:{user}@{HOST}>;tag={tag}",
        f"To: <{uri}>",
        f"Call-ID: {callid}",
        f"CSeq: 1 {method}",
        f"Contact: <sip:{user}@{lip}:{lport}>",
        "User-Agent: santralio-check",
    ]
    if auth:
        lines.append(auth)
    lines += ["Content-Length: 0", "", ""]
    sock.send("\r\n".join(lines).encode())
    codes = []
    try:
        while True:
            data = sock.recv(4096).decode(errors="replace")
            code = int(data.split(" ", 2)[1])
            codes.append(code)
            if code >= 200:
                break
    except socket.timeout:
        pass
    sock.close()
    return codes


CASES = [
    ("REGISTER", "1001", "1001", None),
    ("REGISTER", "t1_1001", "t1_1001", None),
    ("INVITE", "anonymous", "1001", None),
    ("INVITE", "attacker", "00441234567890", None),
    ("INVITE", "t1_1001", "1002",
     'Authorization: Digest username="t1_1001", realm="asterisk", '
     'nonce="00", uri="sip:1002", response="00000000000000000000000000000000"'),
]

failed = False
for method, user, to_user, auth in CASES:
    codes = request(method, user, to_user, auth)
    final = [c for c in codes if c >= 200]
    ok = bool(final) and final[-1] >= 400
    failed |= not ok
    label = "REDDEDİLDİ" if ok else "KABUL/YANIT YOK"
    print(f"{method:8} from={user:10} to={to_user:15} -> {codes or '-'}  {label}")

sys.exit(1 if failed else 0)
