# syntax=docker/dockerfile:1.7
FROM denoland/deno:bin-2.9.6@sha256:4cf0029b9aeeeed5efcbb71828737f0d7c8c8a20072df960e51a5679ef0d21ba AS deno
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:adcd20c7b4c988b73cbfbddb26d2eee574571e6d7c9ffea29b3821e0690efb77
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
