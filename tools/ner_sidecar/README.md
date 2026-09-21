# Reference local NER detector

A small loopback service that finds person names and physical addresses with a purpose-built entity
model and answers Egrysa's local NER detector contract. It is evaluation scaffolding that runs
inside the customer boundary, like Ollama does for the semantic detector. The gateway carries no
third-party runtime code; this process is where the model dependency lives.

## Why a separate process

The semantic detector asks a chat model to find names. Measured on the shipped semantic and scenario
cases on an Apple M4, CPU only:

| Detector                                        | Name recall / precision | Address recall / precision | Latency   |
| ----------------------------------------------- | ----------------------- | -------------------------- | --------- |
| Semantic detector, `qwen2.5:3b`                 | 50% / 100%              | 100% / 100%                | 2.8 s p95 |
| Semantic detector, `llama3.2:3b`                | timed out on every case |                            | 10 s      |
| Semantic detector, `gpt-oss:20b` (July record)  | 100% / 100%             | 100% / 80%                 | 12 s p95  |
| This sidecar, zero-shot labels, no filter       | 100% / 21%              | 100% / 60%                 | 42 ms p50 |
| **This sidecar as shipped** (labels and filter) | **100% / 75%**          | **100% / 100%**            | **42 ms** |

The two remaining name false positives on that set were an unlabelled real name and a configured
confidential term that overlap resolution assigns to `confidential_term` anyway.

## Run it

```sh
python3 -m venv .venv && . .venv/bin/activate
pip install -r tools/ner_sidecar/requirements.txt
python3 tools/ner_sidecar/server.py
```

The first start downloads the model (about 500 MB) from Hugging Face at the pinned revision. After
that it runs offline. It listens on `127.0.0.1:11436`; set `EGRYSA_NER_PORT` to change that. Only
loopback is bound, and the gateway's configuration validation refuses any other host.

Then enable the detector in the gateway configuration:

```json
{
  "nerDetector": {
    "enabled": true,
    "baseUrl": "http://127.0.0.1:11436",
    "timeoutMs": 2000,
    "totalTimeoutMs": 6000,
    "maxInputBytes": 16384,
    "minConfidence": 0.5,
    "onDetectorFailure": "degrade",
    "kinds": ["person_name", "physical_address"]
  }
}
```

`person_name` and `physical_address` must be in `transformKinds`, as the shipped examples have them.
Findings are low precision by design, so they can never hard-deny a request on their own.

Measure it on your own machine before enabling it on interactive traffic:

```sh
EGRYSA_CONFIG=config/<your-config>.json deno task eval:ner
```

## In a container

Run the sidecar as a second container in the same pod (Kubernetes) or the same network namespace
(`--network container:<gateway>`), so it is reachable from the gateway at `127.0.0.1:11436`. It
needs no volume beyond a model cache and no network egress after the model is cached. Keep it
non-root and read-only like the gateway.

## What it does not do

It does not log, persist, or forward request text. It does not detect anything except the two kinds
above. It is not a substitute for the deterministic floor, which still runs first and wins overlaps.
The candidate filter is tuned on the shipped corpora; measure it on yours.
