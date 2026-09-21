export class Metrics {
  requests = 0;
  denied = 0;
  transformed = 0;
  providerErrors = 0;
  recompositionFailures = 0;
  detectorFailures = 0;
  detectorTimeouts = 0;
  semanticFindings = 0;
  responseFindings = 0;
  responseRedactions = 0;
  responseDenials = 0;
  rateLimited = 0;
  inFlight = 0;
  #detectorLatencyCount = 0;
  #detectorLatencyTotalMs = 0;
  #detectorLatencyMinMs = Number.POSITIVE_INFINITY;
  #detectorLatencyMaxMs = 0;

  recordDetectorRun(
    latencyMs: number,
    failureClass?: string,
  ): void {
    this.#detectorLatencyCount++;
    this.#detectorLatencyTotalMs += latencyMs;
    this.#detectorLatencyMinMs = Math.min(this.#detectorLatencyMinMs, latencyMs);
    this.#detectorLatencyMaxMs = Math.max(this.#detectorLatencyMaxMs, latencyMs);
    if (failureClass !== undefined) this.detectorFailures++;
    if (failureClass === "timeout") this.detectorTimeouts++;
  }

  render(): string {
    return [
      "# HELP egrysa_requests_total Total accepted API requests.",
      "# TYPE egrysa_requests_total counter",
      `egrysa_requests_total ${this.requests}`,
      "# HELP egrysa_denied_total Requests denied by policy.",
      "# TYPE egrysa_denied_total counter",
      `egrysa_denied_total ${this.denied}`,
      "# HELP egrysa_transformed_total Requests transformed before egress.",
      "# TYPE egrysa_transformed_total counter",
      `egrysa_transformed_total ${this.transformed}`,
      "# HELP egrysa_provider_errors_total Upstream provider failures.",
      "# TYPE egrysa_provider_errors_total counter",
      `egrysa_provider_errors_total ${this.providerErrors}`,
      "# HELP egrysa_recomposition_failures_total Provider responses containing damaged surrogate tokens.",
      "# TYPE egrysa_recomposition_failures_total counter",
      `egrysa_recomposition_failures_total ${this.recompositionFailures}`,
      "# HELP egrysa_rate_limited_total Requests refused because a workload exceeded its rate limit.",
      "# TYPE egrysa_rate_limited_total counter",
      `egrysa_rate_limited_total ${this.rateLimited}`,
      "# HELP egrysa_response_findings_total Sensitive values found in provider responses, before recomposition.",
      "# TYPE egrysa_response_findings_total counter",
      `egrysa_response_findings_total ${this.responseFindings}`,
      "# HELP egrysa_response_redactions_total Provider responses with at least one value redacted.",
      "# TYPE egrysa_response_redactions_total counter",
      `egrysa_response_redactions_total ${this.responseRedactions}`,
      "# HELP egrysa_response_denials_total Provider responses refused because of a blocked data class.",
      "# TYPE egrysa_response_denials_total counter",
      `egrysa_response_denials_total ${this.responseDenials}`,
      "# HELP egrysa_detector_failures_total Local semantic detector failures.",
      "# TYPE egrysa_detector_failures_total counter",
      `egrysa_detector_failures_total ${this.detectorFailures}`,
      "# HELP egrysa_detector_timeouts_total Local semantic detector timeouts.",
      "# TYPE egrysa_detector_timeouts_total counter",
      `egrysa_detector_timeouts_total ${this.detectorTimeouts}`,
      "# HELP egrysa_semantic_findings_total Accepted local semantic findings.",
      "# TYPE egrysa_semantic_findings_total counter",
      `egrysa_semantic_findings_total ${this.semanticFindings}`,
      "# HELP egrysa_detector_latency_ms Local semantic detector latency in milliseconds.",
      "# TYPE egrysa_detector_latency_ms summary",
      `egrysa_detector_latency_ms_count ${this.#detectorLatencyCount}`,
      `egrysa_detector_latency_ms_sum ${this.#detectorLatencyTotalMs}`,
      "# HELP egrysa_detector_latency_ms_min Minimum observed local semantic detector latency.",
      "# TYPE egrysa_detector_latency_ms_min gauge",
      `egrysa_detector_latency_ms_min ${
        this.#detectorLatencyCount ? this.#detectorLatencyMinMs : 0
      }`,
      "# HELP egrysa_detector_latency_ms_mean Mean observed local semantic detector latency.",
      "# TYPE egrysa_detector_latency_ms_mean gauge",
      `egrysa_detector_latency_ms_mean ${
        this.#detectorLatencyCount ? this.#detectorLatencyTotalMs / this.#detectorLatencyCount : 0
      }`,
      "# HELP egrysa_detector_latency_ms_max Maximum observed local semantic detector latency.",
      "# TYPE egrysa_detector_latency_ms_max gauge",
      `egrysa_detector_latency_ms_max ${this.#detectorLatencyMaxMs}`,
      "# HELP egrysa_in_flight Current API requests.",
      "# TYPE egrysa_in_flight gauge",
      `egrysa_in_flight ${this.inFlight}`,
      "",
    ].join("\n");
  }
}
