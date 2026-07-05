import type { Config } from "@netlify/edge-functions";
import {
  corsHeaders,
  errorResponse,
  firebaseErrorMessage,
  readJsonBody,
  responseFromFirebase,
  signIn,
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

    const docId = String(payload.id || "").trim();
    const password = String(payload.password || "");
    if (!docId || !password)
      return errorResponse({
        code: 400,
        message: "id and password required",
      });

    const email = `${docId}@notepade.web.app`;
    const signInResult = await signIn(email, password);
    if (signInResult.ok) return responseFromFirebase(signInResult);

    if (firebaseErrorMessage(signInResult) !== "EMAIL_NOT_FOUND") {
      return responseFromFirebase(signInResult);
    }

    const signUpResult = await signUp(email, password);
    if (signUpResult.ok) return responseFromFirebase(signUpResult);

    if (firebaseErrorMessage(signUpResult) === "EMAIL_EXISTS") {
      return responseFromFirebase(await signIn(email, password));
    }

    return responseFromFirebase(signUpResult);
  } catch (err: any) {
    return errorResponse(err);
  }
};

export const config: Config = { path: "/auth/password" };
