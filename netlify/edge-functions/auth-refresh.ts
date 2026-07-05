import type { Config } from "@netlify/edge-functions";
import {
  corsHeaders,
  errorResponse,
  firebaseApiKey,
  FirebaseResponse,
  JsonObject,
  readJsonBody,
  responseFromFirebase,
} from "./shared/auth.ts";

type FirebaseRefreshResponse = {
  expires_in: string; // The number of seconds in which the ID token expires.
  token_type: string; // The type of the refresh token, always "Bearer".
  refresh_token: string; // The Firebase Auth refresh token provided in the request or a new refresh token.
  id_token: string; // A Firebase Auth ID token.
  user_id: string; // The uid corresponding to the provided ID token.
  project_id: string; // Your Firebase project ID.
};

function tokenApiUrl() {
  const apiKey = firebaseApiKey();
  const url = new URL("https://securetoken.googleapis.com/v1/token");
  url.searchParams.set("key", apiKey);
  return url;
}

async function refreshFirebaseToken(refreshToken: string) {
  const response = await fetch(tokenApiUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: Netlify?.env?.get?.("FIREBASE_REFERER") ?? "",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as FirebaseRefreshResponse,
  } satisfies FirebaseResponse;
}

export default async (req: Request) => {
  // This is needed if you're planning to invoke your function from a browser.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse({ message: "invalid method", code: 403 });
  }

  try {
    const payload = await readJsonBody(req);

    const refreshToken = String(
      payload.refreshToken || payload.refresh_token || "",
    ).trim();
    if (!refreshToken)
      return errorResponse({ code: 400, message: "refreshToken required" });

    return responseFromFirebase(await refreshFirebaseToken(refreshToken));
  } catch (err: any) {
    return errorResponse(err);
  }
};

export const config: Config = { path: "/auth/refresh" };
