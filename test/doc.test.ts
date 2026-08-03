import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import documentHandler from "../netlify/edge-functions/doc.ts";

type FetchCall = Parameters<typeof fetch>;
type NetlifyGlobal = {
  Netlify?: {
    env: {
      get(name: string): string | undefined;
    };
  };
};

const netlifyGlobal = globalThis as typeof globalThis & NetlifyGlobal;
const originalFetch = globalThis.fetch;
const hadNetlifyGlobal = Object.hasOwn(netlifyGlobal, "Netlify");
const originalNetlify = netlifyGlobal.Netlify;
let fetchCalls: FetchCall[];
let pendingResponses: Response[];

function setEnvironment(values: Record<string, string | undefined>) {
  netlifyGlobal.Netlify = {
    env: {
      get(name) {
        return values[name];
      },
    },
  };
}

function queueJsonResponse(body: unknown, status = 200) {
  pendingResponses.push(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function contextFor(id = "note-1") {
  return { params: { id } } as never;
}

function requestUrl(index: number) {
  return new URL(String(fetchCalls[index][0]));
}

function requestJsonBody(index: number) {
  const body = fetchCalls[index][1]?.body;
  assert.equal(typeof body, "string");
  return JSON.parse(body);
}

function assertFirestoreRequest(index: number, field: string) {
  const url = requestUrl(index);

  assert.equal(url.origin, "https://firestore.googleapis.com");
  assert.equal(
    url.pathname,
    "/v1/projects/test-project/databases/(default)/documents/docs/note-1",
  );
  assert.equal(url.searchParams.get("updateMask.fieldPaths"), field);
}

beforeEach(() => {
  fetchCalls = [];
  pendingResponses = [];
  setEnvironment({
    FIREBASE_API_KEY: "test-api-key",
    FIREBASE_PROJECT_ID: "test-project",
    FIREBASE_REFERER: "https://app.example.test",
  });

  globalThis.fetch = (async (...args: FetchCall) => {
    fetchCalls.push(args);
    const response = pendingResponses.shift();
    if (!response) throw new Error(`Unexpected fetch request: ${args[0]}`);
    return response;
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (hadNetlifyGlobal) netlifyGlobal.Netlify = originalNetlify;
  else delete netlifyGlobal.Netlify;
});

describe("document edge function", () => {
  it("handles CORS preflight and rejects requests without an id or supported method", async () => {
    const preflight = await documentHandler(
      new Request("https://api.example.test/doc/note-1", { method: "OPTIONS" }),
      contextFor(),
    );
    const missingId = await documentHandler(
      new Request("https://api.example.test/doc", { method: "GET" }),
      { params: {} } as never,
    );
    const unsupported = await documentHandler(
      new Request("https://api.example.test/doc/note-1", { method: "DELETE" }),
      contextFor(),
    );

    assert.equal(preflight.status, 200);
    assert.equal(await preflight.text(), "ok");
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(missingId.status, 400);
    assert.equal(await missingId.text(), "Bad Request");
    assert.equal(unsupported.status, 403);
    assert.equal(await unsupported.text(), "invalid method");
    assert.equal(fetchCalls.length, 0);
  });

  it("reads document text with the requested subtype and forwards authorization", async () => {
    queueJsonResponse({
      fields: { text: { stringValue: "# A note" } },
    });

    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1?subtype=markdown", {
        headers: { Authorization: "Bearer id-token" },
      }),
      contextFor(),
    );
    const url = requestUrl(0);

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "# A note");
    assert.equal(
      response.headers.get("Content-Type"),
      "text/markdown; charset=utf-8",
    );
    assert.equal(url.origin, "https://firestore.googleapis.com");
    assert.equal(
      url.pathname,
      "/v1/projects/test-project/databases/(default)/documents/docs/note-1",
    );
    assert.equal(fetchCalls[0][1]?.method, "GET");
    assert.deepEqual(fetchCalls[0][1]?.headers, {
      Authorization: "Bearer id-token",
    });
  });

  it("reports special document fields and decodes image content", async () => {
    queueJsonResponse({
      fields: { protected: { stringValue: "user-1" } },
    });
    queueJsonResponse({
      fields: { text: { stringValue: "data:image/png;base64,SGk=" } },
    });

    const protectedField = await documentHandler(
      new Request("https://api.example.test/doc/note-1?field=protected"),
      contextFor(),
    );
    const image = await documentHandler(
      new Request("https://api.example.test/doc/note-1?image"),
      contextFor(),
    );

    assert.equal(await protectedField.text(), "true");
    assert.equal(
      protectedField.headers.get("Content-Type"),
      "text/plain; charset=utf-8",
    );
    assert.equal(image.headers.get("Content-Type"), "image/png");
    assert.equal(image.headers.get("Content-Length"), "2");
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [72, 105]);
  });

  it("writes text through Firestore's update mask", async () => {
    queueJsonResponse({});

    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1", {
        method: "POST",
        body: "updated note text",
      }),
      contextFor(),
    );

    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
    assertFirestoreRequest(0, "text");
    assert.equal(fetchCalls[0][1]?.method, "PATCH");
    assert.deepEqual(requestJsonBody(0), {
      fields: { text: { stringValue: "updated note text" } },
    });
  });

  it("rejects invalid protected field values before contacting Firestore", async () => {
    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1?field=protected", {
        method: "POST",
        body: "yes",
      }),
      contextFor(),
    );

    assert.equal(response.status, 400);
    assert.equal(
      await response.text(),
      "protected field must be true or false",
    );
    assert.equal(fetchCalls.length, 0);
  });

  it("stores the authenticated user when protecting a document", async () => {
    queueJsonResponse({ users: [{ localId: "owner-1" }] });
    queueJsonResponse({});

    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1?field=protected", {
        method: "POST",
        headers: { Authorization: "Bearer owner-token" },
        body: "true",
      }),
      contextFor(),
    );

    assert.equal(response.status, 200);
    assert.equal(fetchCalls.length, 2);
    assert.equal(
      requestUrl(0).origin,
      "https://identitytoolkit.googleapis.com",
    );
    assert.equal(requestUrl(0).pathname, "/v1/accounts:lookup");
    assert.deepEqual(requestJsonBody(0), { idToken: "owner-token" });
    assertFirestoreRequest(1, "protected");
    assert.deepEqual(fetchCalls[1][1]?.headers, {
      Authorization: "Bearer owner-token",
    });
    assert.deepEqual(requestJsonBody(1), {
      fields: { protected: { stringValue: "owner-1" } },
    });
  });

  it("clears the public field through an empty masked Firestore update", async () => {
    queueJsonResponse({});

    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1?field=public", {
        method: "POST",
        body: "false",
      }),
      contextFor(),
    );

    assert.equal(response.status, 200);
    assertFirestoreRequest(0, "public");
    assert.deepEqual(requestJsonBody(0), { fields: {} });
  });

  it("returns Firestore error payloads as HTTP errors", async () => {
    queueJsonResponse(
      { error: { code: 404, message: "document missing" } },
      404,
    );

    const response = await documentHandler(
      new Request("https://api.example.test/doc/note-1"),
      contextFor(),
    );

    assert.equal(response.status, 404);
    assert.equal(await response.text(), "document missing");
  });
});
