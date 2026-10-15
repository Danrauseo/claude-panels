#!/bin/bash
# Makes a code signing certificate called "Claude Panels Signing" on this Mac, so every build of
# the app is signed the same way. macOS then remembers the permissions you give the app between
# updates. The certificate only exists on this Mac and is not checked by Apple.
#
# macOS asks for your login password once, to trust the certificate for signing code.
set -euo pipefail

NAME="Claude Panels Signing"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"
OPENSSL=/usr/bin/openssl # the copy built into macOS, whose files the keychain accepts

if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
  echo "The \"$NAME\" certificate is already set up."
  exit 0
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<EOF
[ req ]
distinguished_name = dn
x509_extensions = ext
prompt = no
[ dn ]
CN = $NAME
[ ext ]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
EOF

echo "Making the certificate…"
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -config "$WORK/cert.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null

# Bundle the key and certificate with a throwaway password so the keychain can import them.
PASS=$("$OPENSSL" rand -hex 16)
"$OPENSSL" pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -name "$NAME" \
  -out "$WORK/cert.p12" -passout "pass:$PASS"

echo "Adding it to your keychain…"
security import "$WORK/cert.p12" -k "$KEYCHAIN" -P "$PASS" -T /usr/bin/codesign >/dev/null

if [ "${SKIP_TRUST:-}" = "1" ]; then
  echo "Skipped trusting the certificate (SKIP_TRUST=1)."
  exit 0
fi

echo "Trusting it for code signing. macOS will now ask for your login password."
security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" "$WORK/cert.pem"

if security find-identity -v -p codesigning "$KEYCHAIN" | grep -q "\"$NAME\""; then
  echo "Done. Builds will now be signed with \"$NAME\"."
else
  echo "The certificate was added but macOS does not list it as ready for signing yet." >&2
  exit 1
fi
