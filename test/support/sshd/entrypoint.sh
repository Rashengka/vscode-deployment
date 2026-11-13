#!/bin/sh
# Generates a fresh host key and a fresh client key on every start. The test reads the client
# private key and the host public key with `docker exec`; nothing is written to the host.
set -eu

ssh-keygen -q -t ed25519 -N '' -C test-host -f /etc/ssh/ssh_host_ed25519_key

install -d -m 0700 /run/test-client
ssh-keygen -q -t ed25519 -N '' -C test-client -f /run/test-client/id_ed25519

install -d -m 0700 -o deploy -g deploy /home/deploy/.ssh
install -m 0600 -o deploy -g deploy /run/test-client/id_ed25519.pub /home/deploy/.ssh/authorized_keys

touch /run/test-keys-ready
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config.test
