import { expect, test } from "bun:test";
import { applyQuotaProject, forwardHeaders, normalizePath, upstreamUrl } from "./proxy";

test("retargets the host to the regional Vertex endpoint, keeping an already-scoped path", () => {
  const path = "/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent";
  expect(upstreamUrl("us-central1", "my-proj", path, "")).toBe(`https://us-central1-aiplatform.googleapis.com${path}`);
});

test("injects projects/locations scope for the api-key (express) path shape", () => {
  // What @google/genai emits in api-key mode: no project/location prefix.
  const got = normalizePath("/v1/publishers/google/models/gemini-2.5-pro:streamGenerateContent", "my-proj", "us-central1");
  expect(got).toBe("/v1/projects/my-proj/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent");
});

test("leaves an already-scoped path untouched (ADC mode)", () => {
  const p = "/v1/projects/p/locations/l/publishers/google/models/x:generateContent";
  expect(normalizePath(p, "other", "other")).toBe(p);
});

test("leaves an unrecognized path shape untouched", () => {
  expect(normalizePath("/v1/models", "p", "l")).toBe("/v1/models");
});

test("drops a placeholder ?key= (we authenticate with a Bearer token instead)", () => {
  const out = upstreamUrl("europe-west1", "p", "/v1/publishers/google/models/x:generateContent", "?key=placeholder&alt=sse");
  expect(out).toContain("projects/p/locations/europe-west1");
  expect(out).toContain("alt=sse");
  expect(out).not.toContain("key=");
});

test("applyQuotaProject stamps the project so Vertex can bill a credential with no quota project", () => {
  const h = new Headers();
  applyQuotaProject(h, "my-proj");
  expect(h.get("x-goog-user-project")).toBe("my-proj");
});

test("applyQuotaProject is a no-op when no project is configured", () => {
  const h = new Headers();
  applyQuotaProject(h, "");
  expect(h.has("x-goog-user-project")).toBe(false);
});

test("forwardHeaders strips incoming auth, host, and length but keeps content-type", () => {
  const h = forwardHeaders(
    new Headers({
      host: "hakanai-inference:8900",
      authorization: "Bearer placeholder",
      "x-goog-api-key": "placeholder",
      "content-length": "123",
      "content-type": "application/json",
      "x-custom": "keep",
    }),
  );
  expect(h.has("host")).toBe(false);
  expect(h.has("authorization")).toBe(false);
  expect(h.has("x-goog-api-key")).toBe(false);
  expect(h.has("content-length")).toBe(false);
  expect(h.get("content-type")).toBe("application/json");
  expect(h.get("x-custom")).toBe("keep");
});
