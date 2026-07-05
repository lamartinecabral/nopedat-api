import type { Config } from "@netlify/edge-functions";
import {
  corsHeaders,
  errorResponse,
  lookupAccount,
  readJsonBody,
  responseFromFirebase,
  signIn,
} from "./shared/auth.ts";

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

    const email = String(payload.email || "").trim();
    const password = String(payload.password || "");
    if (!email || !password)
      return errorResponse({
        code: 400,
        message: "email and password required",
      });

    const signinResult = await signIn(email, password);
    if (!signinResult.ok) {
      return responseFromFirebase(signinResult);
    }

    const lookupResult = await lookupAccount(
      String(signinResult.body.idToken || ""),
    );
    if (!lookupResult.ok) {
      return responseFromFirebase(lookupResult);
    }

    const emailVerified = Boolean(lookupResult.body?.users?.[0]?.emailVerified);

    if (!emailVerified) {
      return errorResponse({ code: 403, message: "email not verified" });
    }

    return responseFromFirebase(signinResult);
  } catch (err: any) {
    return errorResponse(err);
  }
};

export const config: Config = { path: "/auth/signin" };
