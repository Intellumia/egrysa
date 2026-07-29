# syntax=docker/dockerfile:1.7
FROM denoland/deno:bin-2.9.3@sha256:eb93e70bd53efec4be113d9974107840756551bc1a59a8258892d7bbe5fb4ab0 AS deno
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:66aa873a4a14fb164aa01296058efd8253744606d72715e45acface073359faa
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
