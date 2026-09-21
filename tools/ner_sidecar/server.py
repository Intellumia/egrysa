#!/usr/bin/env python3
"""Reference customer-local named-entity detector for Egrysa.

Runs a small PII entity model on loopback and answers Egrysa's local NER
detector contract (see src/ner.ts). It is evaluation scaffolding that lives
inside the customer boundary, like Ollama does for the semantic detector: the
gateway itself carries no third-party runtime code, and this process is the one
place a model dependency is allowed.

The contract is one request, POST /v1/detect:

    {"contractVersion": "1", "kinds": ["person_name", "physical_address"], "text": "..."}

and one response:

    {"contractVersion": "1",
     "detector": {"id": "...", "version": "...", "model": "...", "revision": "..."},
     "findings": [{"kind": "person_name", "text": "Maya Chen", "confidence": 0.91}]}

Candidates are literal substrings of the request text. No offsets are sent;
the gateway locates every occurrence itself. Nothing about a request, neither
text nor candidates, is logged.

Environment:
    EGRYSA_NER_PORT             loopback port (default 11436)
    EGRYSA_NER_MODEL            Hugging Face model id (default urchade/gliner_multi_pii-v1)
    EGRYSA_NER_MODEL_REVISION   pinned commit of that model
    EGRYSA_NER_THRESHOLD        model score threshold (default 0.5)
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = "127.0.0.1"
PORT = int(os.environ.get("EGRYSA_NER_PORT", "11436"))
MODEL = os.environ.get("EGRYSA_NER_MODEL", "urchade/gliner_multi_pii-v1")
REVISION = os.environ.get("EGRYSA_NER_MODEL_REVISION", "1fcf13e85f4eef5394e1fcd406cf2ca9ea82351d")
THRESHOLD = float(os.environ.get("EGRYSA_NER_THRESHOLD", "0.5"))
MAX_BODY_BYTES = 1024 * 1024
MAX_FINDINGS = 512
CONTRACT_VERSION = "1"
DETECTOR_ID = "egrysa.reference.ner-sidecar"
DETECTOR_VERSION = "0.1.0"

# Model labels are natural-language prompts to a zero-shot model, and the
# wording matters: "person" recalls every name in the evaluation set while a
# longer phrasing recalled none. The map keys are what the model is asked for;
# the values are Egrysa finding kinds.
LABELS = {
    "person": "person_name",
    "street address": "physical_address",
    "organization": "organization",
}

# The model fires "person" on role nouns. These are filtered rather than
# lowered in threshold, because a real name and "the patient" score alike.
ROLE_WORDS = {
    "customer", "patient", "staff", "leadership", "member", "party", "holder", "primary",
    "user", "owner", "engineer", "manager", "team", "client", "employee", "contractor",
    "applicant", "candidate", "resident", "tenant", "driver", "operator", "family", "either",
    "account", "pack", "on-call", "colleague", "supplier", "vendor", "partner",
}


def keep(kind: str, text: str) -> bool:
    """Candidate filter measured on the evaluation corpora (see README)."""
    value = text.strip()
    if "@" in value:
        return False
    if kind == "person_name":
        tokens = value.split()
        if len(tokens) < 2 or len(tokens) > 4:
            return False
        if any(token.lower().strip(".,") in ROLE_WORDS for token in tokens):
            return False
        if any(character.isdigit() for character in value):
            return False
        return all(token[0].isupper() for token in tokens)
    if kind == "physical_address":
        return bool(re.search(r"\d", value)) and len(value.split()) >= 3
    if kind == "organization":
        tokens = value.split()
        if not tokens or len(tokens) > 6 or len(value) < 3:
            return False
        if all(token.lower().strip(".,") in ROLE_WORDS for token in tokens):
            return False
        return any(character.isupper() for character in value)
    return False


class Detector:
    def __init__(self) -> None:
        from gliner import GLiNER  # imported here so --help works without the model

        try:
            self.model = GLiNER.from_pretrained(MODEL, revision=REVISION)
        except TypeError:
            self.model = GLiNER.from_pretrained(MODEL)
        self.lock = threading.Lock()

    def detect(self, text: str, kinds: list[str]) -> list[dict]:
        labels = [label for label, kind in LABELS.items() if kind in kinds]
        if not labels:
            return []
        with self.lock:
            entities = self.model.predict_entities(text, labels, threshold=THRESHOLD)
        best: dict[tuple[str, str], float] = {}
        for entity in entities:
            kind = LABELS[entity["label"]]
            candidate = entity["text"]
            if not keep(kind, candidate) or candidate not in text:
                continue
            key = (kind, candidate)
            best[key] = max(best.get(key, 0.0), float(entity["score"]))
        findings = [
            {"kind": kind, "text": candidate, "confidence": round(score, 4)}
            for (kind, candidate), score in best.items()
        ]
        return findings[:MAX_FINDINGS]


class Handler(BaseHTTPRequestHandler):
    detector: Detector

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        # Request logging would record the path only, but the safest log is none.
        return

    def _json(self, status: int, body: dict) -> None:
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(200, {"status": "ok", "model": MODEL, "revision": REVISION})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/v1/detect":
            self._json(404, {"error": "not found"})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(413, {"error": "body must be between 1 byte and 1 MiB"})
            return
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeDecodeError):
            self._json(400, {"error": "invalid JSON"})
            return
        if (
            not isinstance(body, dict)
            or body.get("contractVersion") != CONTRACT_VERSION
            or not isinstance(body.get("kinds"), list)
            or not all(kind in LABELS.values() for kind in body["kinds"])
            or not isinstance(body.get("text"), str)
        ):
            self._json(422, {"error": "unsupported request"})
            return
        findings = self.detector.detect(body["text"], body["kinds"])
        self._json(
            200,
            {
                "contractVersion": CONTRACT_VERSION,
                "detector": {
                    "id": DETECTOR_ID,
                    "version": DETECTOR_VERSION,
                    "model": MODEL,
                    "revision": REVISION,
                },
                "findings": findings,
            },
        )


def main() -> int:
    if "--help" in sys.argv:
        print(__doc__)
        return 0
    Handler.detector = Detector()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Egrysa reference NER detector on http://{HOST}:{PORT}/v1/detect  model {MODEL}@{REVISION[:12]}")
    print("No request content is logged.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
