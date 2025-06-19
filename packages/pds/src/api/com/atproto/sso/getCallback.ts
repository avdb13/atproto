import {
  AuthRequiredError,
  InternalServerError,
  InvalidRequestError,
  MethodNotImplementedError,
} from "@atproto/xrpc-server";
import { AppContext } from "../../../../context";
import { Server } from "../../../../lexicon";
import * as cookie from "cookie";
import { base64url } from "jose";
import {
  OAuthAuthenticationErrorResponse,
  OAuthTokenResponse,
} from "@atproto/oauth-provider";
import { DidDocument, MINUTE } from "@atproto/common";
import { validateInputsForLocalPds } from "../server/createAccount";
import { didDocForSession, safeResolveDidDoc } from "../server/util";
import {
  AccountStatus,
  formatAccountStatus,
} from "../../../../account-manager/account-manager";
import { syncEvtDataFromCommit } from "../../../../sequencer";
import { NullOutput, UserServiceAuthOutput } from "../../../../auth-verifier";
import {
  InputSchema,
  OutputSchema,
} from "../../../../lexicon/types/com/atproto/server/createAccount";
import { INVALID_HANDLE } from "@atproto/syntax";
import { softDeleted } from "../../../../db";
import { ActorAccount } from "../../../../account-manager/helpers/account";

export default function (server: Server, ctx: AppContext) {
  server.com.atproto.sso.getCallback({
    rateLimit: [
      {
        durationMs: 5 * MINUTE,
        points: 50,
      },
    ],
    auth: ctx.authVerifier.userServiceAuthOptional,
    handler: async ({ params, auth, req, res }) => {
      const { code, state } = params;

      if (ctx.entrywayAgent) {
        throw new MethodNotImplementedError("Cannot proxy SSO callbacks yet");
      }

      if (!req.headers.cookie) {
        throw new InvalidRequestError("Cookie header missing");
      }

      const cookies = cookie.parse(
        req.headers.cookie,
      ) as Record<string, undefined | string>;

      const callbackId = cookies["atproto-callback"];

      if (!callbackId) {
        throw new InvalidRequestError("Failed to extract callback cookie");
      }

      // TODO: state check

      const callback = await ctx.ssoManager.getAuthCallback(callbackId);

      if (!callback) {
        throw new InvalidRequestError("Failed to find callback");
      }

      if (callback.state !== callbackId) {
        throw new InvalidRequestError("State mismatch");
      }

      const idp = await ctx.ssoManager.getIdentityProvider(callback.idpId);

      if (!idp) {
        throw new InvalidRequestError(
          `Could not find identity provider: ${callback.idpId}`,
        );
      }

      if (!idp.metadata) {
        idp.metadata = await ctx.ssoManager.fetchMetadata(idp.id);
      }

      const data = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callback.redirectUri,
        client_id: idp.clientId,
        client_secret: idp.clientSecret,
        ...callback.codeVerifier && { code_verifier: callback.codeVerifier },
      });

      let claimsFound: Record<
        string,
        undefined | string
      > = {};

      // get and save the tokens
      const tokenRes = await fetch(idp.metadata.endpoints.token, {
        method: "POST",
        headers: {
          "Content-type": "application/x-www-form-urlencoded",
          "Accept": "application/json",
        },
        body: data,
      });

      const body = await tokenRes.json() as OAuthTokenResponse | {
        error: OAuthAuthenticationErrorResponse;
      };

      if ("error" in body) {
        throw new InvalidRequestError(`${body.error}`);
      }

      if (body.id_token) {
        const idTokenBuffer = body.id_token.split(".").at(1);

        if (!idTokenBuffer) {
          throw new InvalidRequestError(`ID token did not contain claims`);
        }

        const de = new TextDecoder("utf-8");

        claimsFound = JSON.parse(de.decode(
          base64url.decode(idTokenBuffer),
        ));

        console.log(JSON.stringify(claimsFound));
      }

      if (idp.metadata.endpoints.userinfo) {
        const userinfoRes = await fetch(idp.metadata.endpoints.userinfo, {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${body.access_token}`,
            "Accept": "application/json",
          },
        });

        const authHeader = userinfoRes.headers.get("WWW-Authenticate");

        if (authHeader) {
          if (authHeader.startsWith("Basic ")) {
            throw new InvalidRequestError(
              `WWW-Authenticate: Basic`,
            );
          }

          if (authHeader.startsWith("Bearer ")) {
            throw new InvalidRequestError(
              `WWW-Authenticate: ${authHeader.substring("Bearer ".length)}`,
            );
          }
        }

        claimsFound = {
          ...claimsFound,
          ...await userinfoRes.json() as Record<
            string,
            undefined | string
          >,
        };

        console.log(JSON.stringify(claimsFound));
      }

      const sub = claimsFound[idp.metadata.mappings.sub];

      if (!sub) {
        throw new InvalidRequestError(
          `Absent 'sub' claim`,
        );
      }

      const claims = await ctx.ssoManager.getAccountClaims(sub, idp.id);

      let account = claims &&
        await ctx.accountManager.getAccount(
          claims.did.toLowerCase(),
          {
            includeDeactivated: true,
            includeTakenDown: true,
          },
        );

      if (!account) {
        // TODO: make sure AuthClaims get dropped
        if (claims) {
          await ctx.ssoManager.deleteAuthClaims(claims.did, idp.id);

          throw new InternalServerError(
            `unlinked account claims`,
          );
        }

        const email = idp.metadata.mappings.email &&
            claimsFound[idp.metadata.mappings.email] || undefined;

        const username = claimsFound["preferred_username"] ||
          claimsFound["nickname"] ||
          sub;

        // const { handle, did, didDoc, accessJwt, refreshJwt } =
        const { did } = await createAccount(ctx, auth, {
          email,
          handle: `${username}.${ctx.cfg.service.hostname}`,
          did: undefined,
          inviteCode: undefined,
          verificationCode: undefined,
          verificationPhone: undefined,
          password: undefined,
          recoveryKey: undefined,
          plcOp: undefined,
        });

        try {
          await ctx.ssoManager.createAuthClaims({
            did,
            idpId: idp.id,
            sub,
            picture: null,
            email: email || null,
          });

          account = await ctx.accountManager.getAccount(
            did.toLowerCase(),
            {
              includeDeactivated: true,
              includeTakenDown: true,
            },
          );
        } catch (err) {
          await ctx.ssoManager.deleteAuthClaims(did, idp.id);
          await ctx.actorStore.destroy(did);
          throw err;
        }
      }

      if (!account) {
        throw new InternalServerError(
          `TODO`,
        );
      }

      const isSoftDeleted = softDeleted(account);

      if (isSoftDeleted) {
        throw new AuthRequiredError(
          "Account has been taken down",
          "AccountTakedown",
        );
      }

      const [{ accessJwt, refreshJwt }, didDoc] = await Promise.all([
        ctx.accountManager.createSession(
          account.did,
          null,
          isSoftDeleted,
        ),
        didDocForSession(ctx, account.did),
      ]);

      const { status, active } = formatAccountStatus(account);

      return {
        encoding: "application/json",
        body: {
          did: account.did,
          didDoc,
          handle: account.handle ?? INVALID_HANDLE,
          email: account.email ?? undefined,
          emailConfirmed: claimsFound["email_verified"] || false,
          accessJwt,
          refreshJwt,
          active,
          status,
          redirectUri: callback.redirectUri,
        },
      };
    },
  });
}

const createAccount = async (
  ctx: AppContext,
  auth: UserServiceAuthOutput | NullOutput,
  body: InputSchema,
): Promise<OutputSchema> => {
  const requester = auth.credentials?.did ?? null;
  const {
    did,
    handle,
    email,
    password,
    inviteCode,
    signingKey,
    plcOp,
    deactivated,
  } = await validateInputsForLocalPds(ctx, body, requester);

  let didDoc: DidDocument | undefined;
  let creds: { accessJwt: string; refreshJwt: string };
  await ctx.actorStore.create(did, signingKey);
  try {
    const commit = await ctx.actorStore.transact(
      did,
      (actorTxn) => actorTxn.repo.createRepo([]),
    );

    // Generate a real did with PLC
    if (plcOp) {
      try {
        await ctx.plcClient.sendOperation(did, plcOp);
      } catch (err) {
        // req.log.error(
        //   { didKey: ctx.plcRotationKey.did(), handle },
        //   "failed to create did:plc",
        // );
        throw err;
      }
    }

    didDoc = await safeResolveDidDoc(ctx, did, true);

    creds = await ctx.accountManager.createAccountAndSession({
      did,
      handle,
      email,
      password,
      repoCid: commit.cid,
      repoRev: commit.rev,
      inviteCode,
      deactivated,
    });

    if (!deactivated) {
      await ctx.sequencer.sequenceIdentityEvt(did, handle);
      await ctx.sequencer.sequenceAccountEvt(did, AccountStatus.Active);
      await ctx.sequencer.sequenceCommit(did, commit);
      await ctx.sequencer.sequenceSyncEvt(
        did,
        syncEvtDataFromCommit(commit),
      );
    }
    await ctx.accountManager.updateRepoRoot(did, commit.cid, commit.rev);
    await ctx.actorStore.clearReservedKeypair(signingKey.did(), did);
  } catch (err) {
    // this will only be reached if the actor store _did not_ exist before
    await ctx.actorStore.destroy(did);
    throw err;
  }

  return {
    handle,
    did: did,
    didDoc,
    accessJwt: creds.accessJwt,
    refreshJwt: creds.refreshJwt,
  };
};
