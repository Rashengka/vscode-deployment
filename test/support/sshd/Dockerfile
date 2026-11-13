# OpenSSH server for integration and extension tests. It only listens on 127.0.0.1 of the
# host (see test/support/sshd.ts). Host and client keys are generated when the container
# starts, so no key is ever stored in the repository or in the image.
FROM alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf

RUN apk add --no-cache openssh-server \
  && adduser -D -h /home/deploy -s /bin/sh deploy \
  && echo 'deploy:*' | chpasswd -e \
  && mkdir -p /var/www/app \
  && chown deploy:deploy /var/www/app

COPY sshd_config /etc/ssh/sshd_config.test
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0644 /etc/ssh/sshd_config.test && chmod 0755 /usr/local/bin/entrypoint.sh

EXPOSE 2222
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
