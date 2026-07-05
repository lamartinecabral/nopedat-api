import type { Config } from "@netlify/edge-functions";
import {
  corsHeaders,
  errorResponse,
  readJsonBody,
  responseFromFirebase,
  signIn,
  updatePassword,
} from "./shared/auth.ts";

export default async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse({ message: "invalid method", code: 403 });
  }

  try {
    const payload = await readJsonBody(req);

    const email =
      String(payload.email || "").trim() ||
      (payload.id ? `${String(payload.id).trim()}@notepade.web.app` : "");
    const oldPassword = String(payload.oldPassword || "");
    const validToken = String(payload.validToken || "").trim();
    const newPassword = String(payload.newPassword || "");

    if (!newPassword) {
      return errorResponse({ code: 400, message: "newPassword required" });
    }

    if (validToken) {
      return responseFromFirebase(
        await updatePassword(validToken, newPassword),
      );
    }

    if (!email || !oldPassword) {
      return errorResponse({
        code: 400,
        message: "email and oldPassword required when validToken is missing",
      });
    }

    const signInResult = await signIn(email, oldPassword);
    if (!signInResult.ok) {
      return responseFromFirebase(signInResult);
    }

    return responseFromFirebase(
      await updatePassword(
        String(signInResult.body.idToken || ""),
        newPassword,
      ),
    );
  } catch (err: any) {
    return errorResponse(err);
  }
};

export const config: Config = { path: "/auth/update" };
