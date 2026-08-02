import type { Config, Context } from "@netlify/edge-functions";

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

function errorResponse(err: { code?: number; message?: string }) {
  return new Response(err?.message || "Internal Error", {
    headers: corsHeaders,
    status: err?.code || 500,
  });
}

function authHeader(req: Request) {
  const headers: { Authorization?: string } = {};
  if (req.headers.has("Authorization"))
    headers["Authorization"] = req.headers.get("Authorization") as string;
  return headers;
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
    } catch (err: any) {
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
      if (field === "protected")
        if (text) fetchBody.fields.protected = { stringValue: text };
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
    } catch (err: any) {
      return errorResponse(err);
    }
  }

  return errorResponse({ message: "invalid method", code: 403 });
};

export const config: Config = { path: "/doc/:id" };