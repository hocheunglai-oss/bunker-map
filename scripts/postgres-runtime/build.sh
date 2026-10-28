#!/usr/bin/env bash
set -euo pipefail
umask 022
test "$(uname -m)" = x86_64
test "$(node -p 'process.versions.node.split(".")[0]')" = 24
# Lock the package repository to the base image's release, not the moving latest.
release_version="$(rpm -q system-release --qf '%{VERSION}')"
[[ "$release_version" =~ ^2023\.[0-9]+\.[0-9]+$ ]]
dnf install -y --releasever="$release_version" gcc make tar bzip2 binutils findutils gzip openssl openssl-devel zlib-devel ca-certificates
mkdir -p /opt/fcuno-build/source /opt/fcuno-output/postgres/{bin,lib,licenses} /opt/fcuno-test-tls
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --retry 2 \
  https://ftp.postgresql.org/pub/source/v17.11/postgresql-17.11.tar.bz2 \
  --output /opt/fcuno-build/source/postgresql-17.11.tar.bz2
printf '%s  %s\n' dd27f2b3c59e73ed14aa3324901242bf69a032a6347805f274e6260322d42979 /opt/fcuno-build/source/postgresql-17.11.tar.bz2 | sha256sum --check --strict
tar -xjf /opt/fcuno-build/source/postgresql-17.11.tar.bz2 -C /opt/fcuno-build/source
# A compiler wrapper passes a literal $ORIGIN to ld without Makefile/shell
# expansion ambiguities. DT_RPATH also applies to transitive OpenSSL dependencies.
printf '%s\n' '#!/bin/sh' 'exec /usr/bin/gcc "$@" '\''-Wl,--disable-new-dtags,-rpath,$ORIGIN/../lib:$ORIGIN'\''' > /opt/fcuno-build/cc-with-origin
chmod 755 /opt/fcuno-build/cc-with-origin
cd /opt/fcuno-build/source/postgresql-17.11
export SOURCE_DATE_EPOCH=1792537200
export CC=/opt/fcuno-build/cc-with-origin
export CFLAGS='-O2 -g0 -ffile-prefix-map=/opt/fcuno-build=.'
./configure --prefix=/opt/postgres17 --disable-rpath --with-ssl=openssl \
  --without-readline --without-icu --without-ldap --without-gssapi --without-lz4 --without-zstd
make -j2
make install
for command in psql pg_dump pg_restore; do
  install -m 755 "/opt/postgres17/bin/$command" "/opt/fcuno-output/postgres/bin/$command"
done
install -m 755 /opt/postgres17/lib/libpq.so.5 /opt/fcuno-output/postgres/lib/libpq.so.5
for library in libssl.so.3 libcrypto.so.3 libz.so.1; do
  install -m 755 "/usr/lib64/$library" "/opt/fcuno-output/postgres/lib/$library"
done
install -m 644 COPYRIGHT /opt/fcuno-output/postgres/licenses/postgresql-COPYRIGHT
openssl_package="$(rpm -qf /usr/lib64/libcrypto.so.3 --qf '%{NAME}')"
zlib_package="$(rpm -qf /usr/lib64/libz.so.1 --qf '%{NAME}')"
openssl_license="$(rpm -ql "$openssl_package" | awk '/\/LICENSE(\.txt)?$/ {print; exit}')"
zlib_license="$(rpm -ql "$zlib_package" | awk '/\/(README|LICENSE)$/ {print; exit}')"
test -n "$openssl_license" && test -f "$openssl_license"
test -n "$zlib_license" && test -f "$zlib_license"
install -m 644 "$openssl_license" /opt/fcuno-output/postgres/licenses/openssl-LICENSE.txt
install -m 644 "$zlib_license" /opt/fcuno-output/postgres/licenses/zlib-README
for elf in /opt/fcuno-output/postgres/bin/* /opt/fcuno-output/postgres/lib/*; do
  strip --strip-unneeded "$elf"
done
rpm -qa --qf '%{NAME}-%{VERSION}-%{RELEASE}.%{ARCH}\n' | LC_ALL=C sort > /opt/fcuno-output/build-rpms.txt
printf '%s\n' "$release_version" > /opt/fcuno-output/al2023-release.txt
node /opt/fcuno-build/create-manifest.mjs
cd /opt/fcuno-output
sha256sum postgres/manifest.json > manifest.sha256
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner -cf - postgres | gzip -n -6 > postgres17-linux-x64.tar.gz
sha256sum postgres17-linux-x64.tar.gz > artifact.sha256
# Test-only certificates, never copied into the runtime artifact. Valid only for
# synthetic localhost TLS. Production uses the separately pinned Supabase CA.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj '/CN=FCUNO Synthetic Test CA' \
  -keyout /opt/fcuno-test-tls/ca.key -out /opt/fcuno-test-tls/ca.crt
openssl req -newkey rsa:2048 -nodes -sha256 -subj '/CN=localhost' \
  -keyout /opt/fcuno-test-tls/server.key -out /opt/fcuno-test-tls/server.csr
printf '%s\n' 'subjectAltName=DNS:localhost' 'extendedKeyUsage=serverAuth' > /opt/fcuno-test-tls/server.ext
openssl x509 -req -in /opt/fcuno-test-tls/server.csr -CA /opt/fcuno-test-tls/ca.crt -CAkey /opt/fcuno-test-tls/ca.key -CAcreateserial -days 2 -sha256 \
  -extfile /opt/fcuno-test-tls/server.ext -out /opt/fcuno-test-tls/server.crt
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 -subj '/CN=Untrusted Synthetic CA' \
  -keyout /opt/fcuno-test-tls/wrong-ca.key -out /opt/fcuno-test-tls/wrong-ca.crt
chmod 644 /opt/fcuno-test-tls/*.crt
chmod 600 /opt/fcuno-test-tls/*.key
chown -R 10001:10001 /opt/fcuno-test-tls
