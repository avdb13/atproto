import {
  InvalidRequestError,
  MethodNotImplementedError,
} from "@atproto/xrpc-server";
import { AppContext } from "../../../../context";
import { Server } from "../../../../lexicon";
import { randomBytes, subtle } from "node:crypto";
import { CookieSerializeOptions, serialize as serializeCookie } from "cookie";
import { base64url } from "jose";
import { ServerResponse } from "node:http";
import { ssoLogger as log } from "../../../../logger";

export function appendHeader(
  res: ServerResponse,
  header: string,
  value: string | readonly string[],
): void {
  const existing = res.getHeader(header);
  if (existing == null) {
    res.setHeader(header, value);
  } else {
    const arr = Array.isArray(existing) ? existing : [String(existing)];
    res.setHeader(header, arr.concat(value));
  }
}

// @NOTE Cookie based CSRF protection is redundant with session cookies using
// `SameSite` and could probably be removed in the future.
const getCallbackCookieOptions = (): Readonly<CookieSerializeOptions> => ({
  expires: new Date(Date.now() + 6e3 * 5), // "session" cookie
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/xrpc/com.atproto.sso.getCallback",
});

export function generateRandomStr(length: number) {
  return randomBytes(Math.ceil(length / 2)).toString("hex").slice(0, length);
}

const generatePKCE = async () => {
  const verifier = generateRandomStr(32);

  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );

  return {
    challenge: base64url.encode(new Uint8Array(digest)),
    verifier,
  };
};

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.sso.getRedirect({
    handler: async ({ params: { idpId, redirectUri }, res }) => {
      if (ctx.entrywayAgent) {
        throw new MethodNotImplementedError("Cannot proxy SSO redirects yet");
      }

      const idp = await ctx.ssoManager.getIdentityProvider(idpId);

      if (!idp) {
        throw new InvalidRequestError(
          `Could not find identity provider: ${idpId}`,
        );
      }

      try {
        new URL(redirectUri);
      } catch (error) {
        throw new InvalidRequestError(
          `Could not parse redirect URI: ${error}`,
        );
      }

      if (!idp.metadata) {
        console.log("fetching metadata");

        idp.metadata = await ctx.ssoManager.fetchMetadata(idp.id);
      }

      const pkce = idp.usePkce &&
          idp.metadata.codeChallengeMethods.some((m) => m === "S256")
        ? await generatePKCE()
        : null;

      const authCallback = {
        idpId: idp.id,
        state: generateRandomStr(32),
        nonce: generateRandomStr(32),
        scopes: idp.scopes.filter((s) =>
          idp.metadata
            ? idp.metadata.scopesSupported.some((ss) => s === ss)
            : true
        ).join(" "),
        redirectUri,
        codeVerifier: pkce?.verifier || null,
      };

      await ctx.ssoManager.createAuthCallback(authCallback);

      const query = new URLSearchParams({
        client_id: idp.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: idp.scopes.join(" "),
        state: authCallback.state,
      });

      const location = new URL(idp.metadata.endpoints.authorization);

      for (const [k, v] of query.entries()) {
        location.searchParams.append(k, v);
      }

      if (pkce) {
        location.searchParams.append("code_challenge", pkce.challenge);
        location.searchParams.append("code_challenge_method", "S256");
      }

      const cookie = serializeCookie(
        "atproto-callback",
        authCallback.state,
        getCallbackCookieOptions(),
      );

      appendHeader(
        res,
        "Set-Cookie",
        cookie,
      );

      appendHeader(res, "Location", location.toString());

      return {
        encoding: "application/json",
        body: {
          state: authCallback.state,
        },
      };
    },
  });
}
