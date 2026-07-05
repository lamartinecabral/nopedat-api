import type { Config } from "@netlify/edge-functions";
import {
  corsHeaders,
  errorResponse,
  readJsonBody,
  responseFromFirebase,
  sendEmailVerification,
  signUp,
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

    const signupResult = await signUp(email, password);
    if (!signupResult.ok) {
      return responseFromFirebase(signupResult);
    }

    const verificationResult = await sendEmailVerification(
      String(signupResult.body.idToken || ""),
    );
    if (!verificationResult.ok) {
      return responseFromFirebase(verificationResult);
    }

    return responseFromFirebase(signupResult);
  } catch (err: any) {
    return errorResponse(err);
  }
};

export const config: Config = { path: "/auth/signup" };
