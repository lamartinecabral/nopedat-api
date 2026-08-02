import type { Config, Context } from "@netlify/edge-functions";
import { lookupAccount } from "./shared/auth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization",
};

function firebaseProjectId() {
  const projectId = Netlify.env.get("FIREBASE_PROJECT_ID");
  if (!projectId)
    throw {
      message: "Missing FIREBASE_PROJECT_ID",
      code: 500,
    };
  return projectId;
}

function firestoreApiUrl(id: string) {
  return new URL(
    "https://firestore.googleapis.com/v1/" +
      `projects/${firebaseProjectId()}/databases/(default)/documents/docs/` +
      id,
  );
}

function errorResponse(err: unknown) {
  const error =
    typeof err === "object" && err !== null
      ? (err as { code?: unknown; message?: unknown })
      : {};
  return new Response(
    typeof error.message === "string" ? error.message : "Internal Error",
    {
      headers: corsHeaders,
      status: typeof error.code === "number" ? error.code : 500,
    },
  );
}

function authHeader(req: Request) {
  const headers: { Authorization?: string } = {};
  if (req.headers.has("Authorization"))
    headers["Authorization"] = req.headers.get("Authorization") as string;
  return headers;
}

async function authenticatedUserId(req: Request) {
  const authorization = req.headers.get("Authorization");
  const idToken = authorization?.match(/^Bearer\s+(.+)$/i)?.[1].trim();
  if (!idToken) throw { message: "Unauthorized", code: 401 };

  const account = await lookupAccount(idToken);
  const userId = account.ok ? account.body.users[0]?.localId : undefined;
  if (!userId) throw { message: "Unauthorized", code: 401 };

  return userId;
}

export default async (req: Request, context: Context) => {
  const id = context.params.id;

  // This is needed if you're planning to invoke your function from a browser.
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (!id) return errorResponse({ message: "Bad Request", code: 400 });

  if (req.method === "GET") {
    const searchParams = new URL(req.url).searchParams;

    try {
      const text = await fetch(firestoreApiUrl(id), {
        method: "GET",
        headers: authHeader(req),
      })
        .then((a) => a.json())
        .then((a) => {
          if (a.error) throw a.error;
          return a.fields.text.stringValue;
        });

      const isImage = searchParams.get("image") !== null;
      if (isImage) {
        const dataUrl = text;
        const [rest, base64Data] = dataUrl.split(",");
        const contentType = rest.split(":")[1].split(";")[0];
        const binaryData = Uint8Array.from(atob(base64Data), (c) =>
          c.charCodeAt(0),
        );
        return new Response(binaryData, {
          headers: {
            ...corsHeaders,
            "Content-Type": contentType,
            "Content-Length": binaryData.byteLength.toString(),
          },
        });
      }

      const subtype = searchParams.get("subtype") || "plain";

      return new Response(text, {
        headers: {
          ...corsHeaders,
          "Content-Type": `text/${subtype}; charset=utf-8`,
        },
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  if (req.method === "POST") {
    const field = new URL(req.url).searchParams.get("field") || "text";
    const text = await req.text();
    try {
      const fetchUrl = firestoreApiUrl(id);
      const fetchBody: {
        fields: {
          text?: { stringValue: string };
          protected?: { stringValue: string };
          public?: { booleanValue: boolean };
        };
      } = { fields: {} };

      fetchUrl.searchParams.set("updateMask.fieldPaths", field);
      if (field === "text") fetchBody.fields.text = { stringValue: text };
      if (field === "protected") {
        if (text !== "true" && text !== "false")
          return errorResponse({
            message: "protected field must be true or false",
            code: 400,
          });
        const userId = await authenticatedUserId(req);
        if (text === "true")
          fetchBody.fields.protected = {
            stringValue: userId,
          };
      }
      if (field === "public")
        if (text) fetchBody.fields.public = { booleanValue: !!text };

      await fetch(fetchUrl, {
        method: "PATCH",
        headers: authHeader(req),
        body: JSON.stringify(fetchBody),
      })
        .then((a) => a.json())
        .then((a) => {
          if (a.error) throw a.error;
        });

      return new Response("ok", { headers: corsHeaders });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return errorResponse({ message: "invalid method", code: 403 });
};

export const config: Config = { path: "/doc/:id" };
