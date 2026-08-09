# syntax=docker/dockerfile:1.7
FROM denoland/deno:bin-2.9.4@sha256:25675bd2a125b59bdcfbb6592ec5c332a2bc56e0dabf038184d8b2c6aec45c3b AS deno
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e
WORKDIR /app
COPY --from=deno /deno /usr/local/bin/deno
COPY --chown=65532:65532 deno.json ./deno.json
COPY --chown=65532:65532 src ./src
COPY --chown=65532:65532 config ./config
ENV EGRYSA_CONFIG=/app/config/egrysa.container.json
USER 65532:65532
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/deno"]
CMD ["run", "--frozen", "--cached-only", "--no-prompt", "--allow-read=/app/config,/var/lib/egrysa", "--allow-write=/var/lib/egrysa", "--allow-env=EGRYSA_CONFIG,EGRYSA_INBOUND_KEYS,EGRYSA_RECEIPT_FINGERPRINT_KEY,EGRYSA_RECEIPT_ED25519_PRIVATE_KEY,EGRYSA_RECEIPT_ED25519_PUBLIC_KEY,OPENAI_API_KEY,ANTHROPIC_API_KEY", "--allow-net=0.0.0.0:8787,api.openai.com,api.anthropic.com,localhost:11434", "/app/src/main.ts"]
