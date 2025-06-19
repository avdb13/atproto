import { InternalServerError } from "@atproto/xrpc-server";
import { fromJson, toJson } from "../../db";
import { IdentityProvider, SSODb } from "../db";
import { isAuthMethod, Metadata } from "../db/schema/identity-provider";
import { OidcMetadata } from "oidc-client-ts";

export const selectQB = (db: SSODb) =>
  db.db.selectFrom("identity_provider").selectAll();

export type Data =
  & Omit<IdentityProvider, "scopes" | "metadata" | "usePkce" | "discoverable">
  & {
    scopes: Array<string>;
    usePkce: boolean;
    discoverable: boolean;
    metadata: Metadata | null;
  };

export const getIdentityProvider = (
  db: SSODb,
  id: string,
): Promise<Data | null> =>
  selectQB(db).where((qb) => qb.where("id", "=", id))
    .executeTakeFirst().then((found) =>
      found
        ? {
          ...found,
          scopes: found.scopes.split(" "),
          usePkce: found.usePkce === 1,
          discoverable: found.discoverable === 1,
          metadata: found.metadata ? fromJson(found.metadata) : null,
        }
        : null
    );

export const listIdentityProviders = (
  db: SSODb,
): Promise<Array<Data>> =>
  selectQB(db)
    .execute().then((arr) =>
      arr.map((found) => (
        {
          ...found,
          scopes: found.scopes.split(" "),
          usePkce: found.usePkce === 1,
          discoverable: found.discoverable === 1,
          metadata: found.metadata ? fromJson(found.metadata) : null,
        }
      ))
    );

export const registerIdentityProvider = (
  db: SSODb,
  opts: Data,
): Promise<string | null> =>
  db.executeWithRetry(
    db.db
      .insertInto("identity_provider")
      .values({
        ...opts,
        scopes: opts.scopes.join(" "),
        usePkce: opts.usePkce ? 1 : 0,
        discoverable: opts.discoverable ? 1 : 0,
        metadata: opts.metadata ? toJson(opts.metadata) : null,
      })
      .onConflict((oc) => oc.doNothing())
      .returning("id"),
  ).then(([res]) => res?.id || null);

export const fetchMetadata = async (
  db: SSODb,
  id: string,
): Promise<Metadata> => {
  const idp = await getIdentityProvider(db, id);

  if (!idp) {
    throw new InternalServerError(`Missing identity provider with ID '${id}'`);
  }

  try {
    const uri = new URL(idp.issuer);
    uri.pathname = "/.well-known/openid-configuration";

    const response = await fetch(uri, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!response.ok || response.status !== 200) {
      throw new InternalServerError(
        `Failed to fetch metadata for identity provider: ${response.status} ${response.statusText}`,
      );
    }

    const metadata = await response.json() as Partial<OidcMetadata>;

    if (
      !metadata.issuer || !metadata.authorization_endpoint ||
      !metadata.token_endpoint ||
      !metadata.token_endpoint_auth_methods_supported
    ) {
      throw new InternalServerError(
        `Missing field in metadata for identity provider`,
      );
    }

    if (!metadata.claims_supported?.some((c) => c === "sub")) {
      throw new InternalServerError(
        `Missing sub claim for identity provider, claims supported: ${metadata.claims_supported}`,
      );
    }

    const updated: Metadata = {
      endpoints: {
        authorization: metadata.authorization_endpoint,
        token: metadata.token_endpoint,
        userinfo: metadata.userinfo_endpoint ?? null,
      },
      mappings: {
        sub: "sub",
        picture: metadata.claims_supported.find((c) => c === "picture") ?? null,
        email: metadata.claims_supported.find((c) => c === "email") ?? null,
      },
      authMethods: metadata.token_endpoint_auth_methods_supported.filter(
        isAuthMethod,
      ),
      scopesSupported: metadata.scopes_supported ?? [],
      codeChallengeMethods: metadata.code_challenge_methods_supported ?? [],
    };

    const res = await db.db
      .updateTable("identity_provider")
      .set({
        metadata: toJson(updated),
      })
      .where("id", "=", idp.id)
      .returning("id")
      .executeTakeFirst();

    if (!res) {
      throw new InternalServerError(
        `Missing identity provider with ID '${idp.id}'`,
      );
    }

    return updated;
  } catch (error) {
    throw new InternalServerError(
      `Failed to fetch metadata for identity provider: ${error}`,
    );
  }
};

export const deleteIdentityProvider = (
  db: SSODb,
  id: string,
): Promise<void> =>
  db.executeWithRetry(
    db.db.deleteFrom("identity_provider").where("id", "=", id),
  ).then(() => {});
