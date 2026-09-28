FROM alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8

RUN apk add --no-cache openssh-client \
    && addgroup -g 10001 tunnel \
    && adduser -D -H -u 10001 -G tunnel tunnel

USER 10001:10001

ENTRYPOINT ["ssh"]
