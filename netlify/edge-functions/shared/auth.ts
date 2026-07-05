export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type FirebaseSignUpResponse = {
  idToken: string; // A Firebase Auth ID token for the newly created user.
  email: string; // The email for the newly created user.
  refreshToken: string; // A Firebase Auth refresh token for the newly created user.
  expiresIn: string; // The number of seconds in which the ID token expires.
  localId: string; // The uid of the newly created user.
};

type FirebaseSignInResponse = {
  idToken: string; // A Firebase Auth ID token for the authenticated user.
  email: string; // The email for the authenticated user.
  refreshToken: string; // A Firebase Auth refresh token for the authenticated user.
  expiresIn: string; // The number of seconds in which the ID token expires.
  localId: string; // The uid of the authenticated user.
  registered: boolean; // Whether the email is for an existing account.
};

type FirebaseLookupResponse = {
  users: Array<{
    email: string;
    emailVerified: boolean;
    localId: string;
  }>;
};

type FirebaseSendOobCodeResponse = {
  email: string;
};

type FirebaseUpdatePasswordResponse = {
  localId: string;
  email: string;
  passwordHash?: string;
  providerUserInfo?: JsonObject[];
  idToken: string;
  refreshToken: string;
  expiresIn: string;
};

export type JsonObject = Record<string, unknown>;

export type FirebaseResponse = {
  ok: boolean;
  status: number;
  body: JsonObject;
};

export function authenticationApiUrl(path: string) {
  const apiKey = firebaseApiKey();
  const url = new URL(`https://identitytoolkit.googleapis.com/v1/${path}`);
  url.searchParams.set("key", apiKey);
  return url;
}

export function firebaseApiKey() {
  const apiKey = Netlify.env.get("FIREBASE_API_KEY");
  if (!apiKey)
    throw {
      message: "Missing FIREBASE_API_KEY",
      code: 500,
    };
  return apiKey;
}

export function errorResponse(err: { code?: number; message?: string }) {
  return new Response(err?.message || "Internal Error", {
    headers: corsHeaders,
    status: err?.code || 500,
  });
}

export function jsonResponse(body: JsonObject, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

export function responseFromFirebase(result: FirebaseResponse) {
  return jsonResponse(result.body, result.status);
}

export function firebaseErrorMessage(result: FirebaseResponse) {
  const errorBody = result.body.error;
  if (!errorBody || typeof errorBody !== "object") return undefined;

  const message = (errorBody as JsonObject).message;
  return typeof message === "string" ? message : undefined;
}

export async function readJsonBody(req: Request) {
  try {
    return (await req.json()) as JsonObject;
  } catch {
    throw { code: 400, message: "invalid json body" };
  }
}

export async function postFirebaseJson<T extends JsonObject>(
  url: URL,
  body: JsonObject,
) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: Netlify?.env?.get?.("FIREBASE_REFERER") ?? "",
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.ok,
    status: response.status,
    body: (await response.json()) as T,
  } satisfies FirebaseResponse;
}

export function signUp(email: string, password: string) {
  return postFirebaseJson<FirebaseSignUpResponse>(
    authenticationApiUrl("accounts:signUp"),
    {
      email,
      password,
      returnSecureToken: true,
    },
  );
}

export function signIn(email: string, password: string) {
  return postFirebaseJson<FirebaseSignInResponse>(
    authenticationApiUrl("accounts:signInWithPassword"),
    {
      email,
      password,
      returnSecureToken: true,
    },
  );
}

export function lookupAccount(idToken: string) {
  return postFirebaseJson<FirebaseLookupResponse>(
    authenticationApiUrl("accounts:lookup"),
    { idToken },
  );
}

export function sendEmailVerification(idToken: string) {
  return postFirebaseJson<FirebaseSendOobCodeResponse>(
    authenticationApiUrl("accounts:sendOobCode"),
    {
      requestType: "VERIFY_EMAIL",
      idToken,
    },
  );
}

export function updatePassword(idToken: string, password: string) {
  return postFirebaseJson<FirebaseUpdatePasswordResponse>(
    authenticationApiUrl("accounts:update"),
    {
      idToken,
      password,
      returnSecureToken: true,
    },
  );
}
