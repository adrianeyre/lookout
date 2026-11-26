#!/bin/sh
# V2 (#74): what dind can't show, on a disposable Linux VM. Never run this on a Host in use.
#
# Runs inside the VM as root, from a directory holding the shipped compose.yaml and
# compose.socket-proxy.yaml, with the round's Image already loaded as lookout:pen-test:
#
#   sudo sh probe.sh default        # compose.yaml
#   sudo sh probe.sh socket-proxy   # compose.yaml + compose.socket-proxy.yaml
#
# Every proof is read-only and stops at the first sign of access: one file, one listing or
# one request. Every secret is made up and carries PEN-TEST-FAKE. Output lines start with
# "[V2 <configuration>]" so the findings note can quote them.
set -u
CONFIG="${1:?default or socket-proxy}"
say() { printf '[V2 %s] %s\n' "$CONFIG" "$*"; }

# A Host owner (UID 1000, the first account on most Linux Hosts) with made-up secrets, and
# an unprivileged local user outside the docker group.
getent passwd 1000 >/dev/null || useradd --uid 1000 --create-home --shell /bin/sh owner
getent passwd pentest-nobody >/dev/null || useradd --system --no-create-home pentest-nobody
OWNER_HOME=$(getent passwd 1000 | cut -d: -f6)
install -d -m 700 -o 1000 -g 1000 "$OWNER_HOME/.ssh" "$OWNER_HOME/.docker"
printf 'PEN-TEST-FAKE-owner-private-key\n' > "$OWNER_HOME/.ssh/id_ed25519"
printf '{"auths":{"ghcr.io":{"auth":"PEN-TEST-FAKE-registry-token"}}}\n' > "$OWNER_HOME/.docker/config.json"
chown 1000:1000 "$OWNER_HOME/.ssh/id_ed25519" "$OWNER_HOME/.docker/config.json"
chmod 600 "$OWNER_HOME/.ssh/id_ed25519" "$OWNER_HOME/.docker/config.json"
# A service on the Host's loopback only, as a database or an admin panel would be.
docker rm -f v2-loopback-service >/dev/null 2>&1
docker run -d --name v2-loopback-service --network host --entrypoint node lookout:pen-test \
  -e "require('http').createServer((q,s)=>s.end('PEN-TEST-FAKE-loopback-admin\n')).listen(9109,'127.0.0.1')" >/dev/null
# A victim Container with a made-up secret in its environment and a named volume.
docker rm -f v2-victim >/dev/null 2>&1
docker run -d --name v2-victim -e API_TOKEN=PEN-TEST-FAKE-victim-token -v v2-victim-data:/data \
  --entrypoint sleep lookout:pen-test infinity >/dev/null

# Lookout, from the shipped Compose files with only the Image swapped for the round's.
HASH=$(printf 'v2-made-up-password\nv2-made-up-password\n' | docker run --rm -i --entrypoint node \
  lookout:pen-test apps/server/dist/hash-password.js 2>/dev/null | grep -o '\$argon2id\$[^ ]*' | tail -1)
[ -n "$HASH" ] || { say "could not hash the made-up password"; exit 1; }
cat > .env <<EOF
LOOKOUT_PASSWORD_HASH='$HASH'
LOOKOUT_SESSION_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '/+=\n')
LOOKOUT_BIND_ADDRESS=127.0.0.1
DOCKER_GID=$(stat -c %g /var/run/docker.sock)
EOF
[ -f .env.extra ] && cat .env.extra >> .env
cat > v2.override.yaml <<'EOF'
services:
  lookout:
    image: lookout:pen-test
    pull_policy: never
EOF
FILES="-f compose.yaml"
[ "$CONFIG" = socket-proxy ] && FILES="$FILES -f compose.socket-proxy.yaml"
FILES="$FILES -f v2.override.yaml"
docker compose -p lookout-v2 $FILES down --volumes >/dev/null 2>&1
docker compose -p lookout-v2 $FILES up -d --wait >/dev/null 2>&1 || say "compose up failed"
sleep 3

say "Lookout runs as: $(docker exec lookout id)"
say "own user namespace? $(docker inspect -f '{{.HostConfig.UsernsMode}}' lookout)"

# What the real / mount gives Lookout's user (R1's checklist).
for f in "$OWNER_HOME/.ssh/id_ed25519" "$OWNER_HOME/.docker/config.json" /etc/shadow /root \
  /proc/1/environ /proc/1/root /var/lib/docker /var/lib/docker/volumes; do
  if docker exec lookout sh -c "test -d '/host$f'"; then
    out=$(docker exec lookout ls "/host$f" 2>&1 | head -3 | tr '\n' ' ')
  else
    out=$(docker exec lookout head -c 80 "/host$f" 2>&1 | tr -d '\0' | tr '\n' ' ')
  fi
  say "read /host$f: $out"
done
links=$(docker exec lookout sh -c 'cut -d" " -f2 /host/proc/1/mounts | while read m; do [ -L "/host$m" ] && echo "$m"; done' | tr '\n' ' ')
say "mount points that are links: ${links:-none}"

# What network_mode: host gives Lookout: the Host's loopback services and the proxy's port.
say "loopback admin service from Lookout: $(docker exec lookout node -e "fetch('http://127.0.0.1:9109').then(r=>r.text()).then(t=>console.log(t.trim()),e=>console.log('refused: '+e.cause?.code))")"
say "listening on the Host (from Lookout's /proc/net/tcp): $(docker exec lookout sh -c "awk 'NR>1 && \$4==\"0A\" {print \$2}' /proc/net/tcp" | tr '\n' ' ')"

# H2: the proxy's port, as an unprivileged Host user outside the docker group.
say "pentest-nobody groups: $(id pentest-nobody)"
probe() { su -s /bin/sh pentest-nobody -c "curl -s -m 5 -o /dev/null -w '%{http_code}' $*" 2>&1 || true; }
say "pentest-nobody GET 127.0.0.1:2375/containers/json: $(probe http://127.0.0.1:2375/containers/json)"
env=$(su -s /bin/sh pentest-nobody -c "curl -s -m 5 http://127.0.0.1:2375/containers/v2-victim/json" 2>/dev/null | grep -o 'PEN-TEST-FAKE-victim-token' | head -1)
say "pentest-nobody reads v2-victim's environment through the proxy: ${env:-no}"
say "pentest-nobody on the Docker socket: $(su -s /bin/sh pentest-nobody -c 'curl -s -m 5 --unix-socket /var/run/docker.sock http://d/containers/json -o /dev/null -w %{http_code}' 2>&1)"
sock=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/run/lookout-docker"}}{{.Source}}{{end}}{{end}}' lookout 2>/dev/null)
if [ -n "$sock" ]; then
  say "proxy socket directory on the Host: $(ls -ld "$sock" 2>&1)"
  say "pentest-nobody on the proxy's socket: $(su -s /bin/sh pentest-nobody -c "curl -s -m 5 --unix-socket '$sock/docker.sock' http://d/containers/json -o /dev/null -w %{http_code}" 2>&1)"
fi

docker compose -p lookout-v2 $FILES down --volumes >/dev/null 2>&1
docker rm -f v2-loopback-service v2-victim >/dev/null 2>&1
docker volume rm v2-victim-data >/dev/null 2>&1
say "done; Lookout and the V2 Containers removed"
