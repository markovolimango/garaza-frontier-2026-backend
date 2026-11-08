#!/usr/bin/env bash
# Development TLS for LAN testing with a physical iPhone (wss://). Creates a local CA and a server
# certificate for this Mac's .local name and current LAN IP in services/coach/.runtime/tls/.
# Nothing is installed or trusted automatically. See docs/device-setup.md for trusting the CA on iPhone.
set -euo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/_coach_env.sh"
OUT="$COACH_DIR/.runtime/tls"
mkdir -p "$OUT"; chmod 700 "$OUT"
HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"
IP="${1:-$(ipconfig getifaddr en0 2>/dev/null || true)}"
SAN="DNS:$HOST,DNS:localhost,IP:127.0.0.1${IP:+,IP:$IP}"
if [[ ! -f "$OUT/ca.key" ]]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes -keyout "$OUT/ca.key" -out "$OUT/ca.crt" \
    -subj "/CN=garaza-frontier coach dev CA" -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
openssl req -newkey rsa:2048 -sha256 -nodes -keyout "$OUT/server.key" -out "$OUT/server.csr" -subj "/CN=$HOST" 2>/dev/null
printf "subjectAltName=%s\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=CA:FALSE\n" "$SAN" > "$OUT/server.ext"
openssl x509 -req -in "$OUT/server.csr" -CA "$OUT/ca.crt" -CAkey "$OUT/ca.key" -CAcreateserial -days 397 -sha256 \
  -extfile "$OUT/server.ext" -out "$OUT/server.crt" 2>/dev/null
chmod 600 "$OUT"/*.key
echo "CA:     $OUT/ca.crt   (install on the iPhone and enable full trust; keep ca.key private)"
echo "Server: $OUT/server.crt for $SAN"
echo "Start:  bash scripts/coach-serve.sh --lan --tls-cert '$OUT/server.crt' --tls-key '$OUT/server.key'"
echo "iPhone: https://$HOST:8765  (the iPhone's own 'localhost' is the phone, not this Mac)"
