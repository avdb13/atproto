import {
  InvalidRequestError,
  MethodNotImplementedError,
} from "@atproto/xrpc-server";
import { AppContext } from "../../../../context";
import { Server } from "../../../../lexicon";
import { AuthMethod } from "../../../../sso/db/schema/identity-provider";

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.admin.createIdentityProvider({
    auth: ctx.authVerifier.userServiceAuthOptional,
    handler: async ({ input }) => {
      if (ctx.entrywayAgent) {
        throw new MethodNotImplementedError(
          "Cannot proxy creating identity providers yet",
        );
      }

      const idp = input.body;

      const idpId = await ctx.ssoManager.createIdentityProvider({
        id: idp.id,
        name: idp.name ?? null,
        icon: idp.icon ?? null,
        issuer: idp.issuer,
        clientId: idp.clientId,
        clientSecret: idp.clientSecret,
        scopes: idp.scopes,
        usePkce: idp.usePkce,
        discoverable: idp.discoverable,
        metadata: !idp.discoverable && idp.metadata
          ? {
            endpoints: {
              authorization: idp.metadata.endpoints.authorization,
              token: idp.metadata.endpoints.token,
              userinfo: idp.metadata.endpoints.userInfo ?? null,
            },
            mappings: {
              sub: idp.metadata.mappings.sub,
              picture: idp.metadata.mappings.picture ?? null,
              email: idp.metadata.mappings.email ?? null,
            },
            authMethods: idp.metadata.authMethods.map((m) => m as AuthMethod),
            scopesSupported: idp.metadata.scopesSupported,
            codeChallengeMethods: idp.metadata.codeChallengeMethods ?? [],
          }
          : null,
      });

      if (!idpId) {
        throw new InvalidRequestError(
          `Identity provider already exists`,
        );
      }

      return {
        encoding: "application/json",
        body: {
          idpId,
        },
      };
    },
  });
}
