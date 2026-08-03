import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import passwordHandler from "../netlify/edge-functions/auth-password.ts";
import refreshHandler from "../netlify/edge-functions/auth-refresh.ts";
import signinHandler from "../netlify/edge-functions/auth-signin.ts";
import signupHandler from "../netlify/edge-functions/auth-signup.ts";
import updateHandler from "../netlify/edge-functions/auth-update.ts";

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

function jsonRequest(path: string, body: unknown) {
  return new Request(`https://api.example.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function requestUrl(index: number) {
  return new URL(String(fetchCalls[index][0]));
}

function requestJsonBody(index: number) {
  const body = fetchCalls[index][1]?.body;
  assert.equal(typeof body, "string");
  return JSON.parse(body);
}

function assertFirebaseRequest(
  index: number,
  path: string,
  expectedBody: unknown,
) {
  const url = requestUrl(index);
  const init = fetchCalls[index][1];

  assert.equal(url.origin, "https://identitytoolkit.googleapis.com");
  assert.equal(url.pathname, `/v1/${path}`);
  assert.equal(url.searchParams.get("key"), "test-api-key");
  assert.equal(init?.method, "POST");
  assert.deepEqual(requestJsonBody(index), expectedBody);
}

beforeEach(() => {
  fetchCalls = [];
  pendingResponses = [];
  setEnvironment({
    FIREBASE_API_KEY: "test-api-key",
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

describe("authentication edge functions", () => {
  it("rejects malformed and incomplete sign-up requests before calling Firebase", async () => {
    const malformed = await signupHandler(
      new Request("https://api.example.test/auth/signup", {
        method: "POST",
        body: "not json",
      }),
    );
    const incomplete = await signupHandler(
      jsonRequest("/auth/signup", { email: "person@example.test" }),
    );

    assert.equal(malformed.status, 400);
    assert.equal(await malformed.text(), "invalid json body");
    assert.equal(incomplete.status, 400);
    assert.equal(await incomplete.text(), "email and password required");
    assert.equal(fetchCalls.length, 0);
  });

  it("signs up an account and requests email verification", async () => {
    const signUpResult = {
      idToken: "new-id-token",
      email: "person@example.test",
      refreshToken: "refresh-token",
      expiresIn: "3600",
      localId: "user-1",
    };
    queueJsonResponse(signUpResult);
    queueJsonResponse({ email: "person@example.test" });

    const response = await signupHandler(
      jsonRequest("/auth/signup", {
        email: "  person@example.test  ",
        password: "correct horse battery staple",
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), signUpResult);
    assert.equal(fetchCalls.length, 2);
    assertFirebaseRequest(0, "accounts:signUp", {
      email: "person@example.test",
      password: "correct horse battery staple",
      returnSecureToken: true,
    });
    assertFirebaseRequest(1, "accounts:sendOobCode", {
      requestType: "VERIFY_EMAIL",
      idToken: "new-id-token",
    });
  });

  it("returns a Firebase verification failure after a successful sign-up", async () => {
    queueJsonResponse({ idToken: "new-id-token" });
    queueJsonResponse(
      { error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" } },
      429,
    );

    const response = await signupHandler(
      jsonRequest("/auth/signup", {
        email: "person@example.test",
        password: "password",
      }),
    );

    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: { message: "TOO_MANY_ATTEMPTS_TRY_LATER" },
    });
  });

  it("returns sign-in credentials only for verified accounts", async () => {
    const signInResult = {
      idToken: "verified-id-token",
      email: "person@example.test",
      refreshToken: "refresh-token",
      expiresIn: "3600",
      localId: "user-1",
      registered: true,
    };
    queueJsonResponse(signInResult);
    queueJsonResponse({
      users: [
        {
          email: "person@example.test",
          emailVerified: true,
          localId: "user-1",
        },
      ],
    });

    const response = await signinHandler(
      jsonRequest("/auth/signin", {
        email: "person@example.test",
        password: "password",
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), signInResult);
    assertFirebaseRequest(0, "accounts:signInWithPassword", {
      email: "person@example.test",
      password: "password",
      returnSecureToken: true,
    });
    assertFirebaseRequest(1, "accounts:lookup", {
      idToken: "verified-id-token",
    });
  });

  it("rejects an unverified sign-in after checking the account", async () => {
    queueJsonResponse({ idToken: "unverified-id-token" });
    queueJsonResponse({
      users: [{ emailVerified: false, localId: "user-1" }],
    });

    const response = await signinHandler(
      jsonRequest("/auth/signin", {
        email: "person@example.test",
        password: "password",
      }),
    );

    assert.equal(response.status, 403);
    assert.equal(await response.text(), "email not verified");
    assert.equal(fetchCalls.length, 2);
  });

  it("passes a Firebase sign-in failure through without looking up an account", async () => {
    queueJsonResponse({ error: { message: "INVALID_LOGIN_CREDENTIALS" } }, 400);

    const response = await signinHandler(
      jsonRequest("/auth/signin", {
        email: "person@example.test",
        password: "wrong-password",
      }),
    );

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: { message: "INVALID_LOGIN_CREDENTIALS" },
    });
    assert.equal(fetchCalls.length, 1);
  });

  it("exchanges either refresh token field using form-encoded Firebase input", async () => {
    const refreshResult = {
      id_token: "new-id-token",
      refresh_token: "new-refresh-token",
      expires_in: "3600",
      token_type: "Bearer",
      user_id: "user-1",
      project_id: "project-1",
    };
    queueJsonResponse(refreshResult);

    const response = await refreshHandler(
      jsonRequest("/auth/refresh", { refresh_token: "old-refresh-token" }),
    );
    const url = requestUrl(0);
    const body = new URLSearchParams(String(fetchCalls[0][1]?.body));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), refreshResult);
    assert.equal(url.origin, "https://securetoken.googleapis.com");
    assert.equal(url.pathname, "/v1/token");
    assert.equal(url.searchParams.get("key"), "test-api-key");
    assert.equal(fetchCalls[0][1]?.method, "POST");
    assert.equal(body.get("grant_type"), "refresh_token");
    assert.equal(body.get("refresh_token"), "old-refresh-token");
  });

  it("creates a document-password account when its initial sign-in is not found", async () => {
    const signUpResult = { idToken: "document-id-token", localId: "user-1" };
    queueJsonResponse({ error: { message: "EMAIL_NOT_FOUND" } }, 400);
    queueJsonResponse(signUpResult);

    const response = await passwordHandler(
      jsonRequest("/auth/password", { id: "note-123", password: "password" }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), signUpResult);
    assertFirebaseRequest(0, "accounts:signInWithPassword", {
      email: "note-123@notepade.web.app",
      password: "password",
      returnSecureToken: true,
    });
    assertFirebaseRequest(1, "accounts:signUp", {
      email: "note-123@notepade.web.app",
      password: "password",
      returnSecureToken: true,
    });
  });

  it("updates a password directly when a valid token is supplied", async () => {
    const updateResult = {
      idToken: "new-id-token",
      refreshToken: "new-refresh-token",
      expiresIn: "3600",
      localId: "user-1",
      email: "person@example.test",
    };
    queueJsonResponse(updateResult);

    const response = await updateHandler(
      jsonRequest("/auth/update", {
        validToken: "existing-id-token",
        newPassword: "new-password",
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), updateResult);
    assert.equal(fetchCalls.length, 1);
    assertFirebaseRequest(0, "accounts:update", {
      idToken: "existing-id-token",
      password: "new-password",
      returnSecureToken: true,
    });
  });

  it("authenticates with old credentials before updating a password", async () => {
    queueJsonResponse({ idToken: "current-id-token" });
    queueJsonResponse({ idToken: "new-id-token", localId: "user-1" });

    const response = await updateHandler(
      jsonRequest("/auth/update", {
        email: "person@example.test",
        oldPassword: "old-password",
        newPassword: "new-password",
      }),
    );

    assert.equal(response.status, 200);
    assertFirebaseRequest(0, "accounts:signInWithPassword", {
      email: "person@example.test",
      password: "old-password",
      returnSecureToken: true,
    });
    assertFirebaseRequest(1, "accounts:update", {
      idToken: "current-id-token",
      password: "new-password",
      returnSecureToken: true,
    });
  });
});
