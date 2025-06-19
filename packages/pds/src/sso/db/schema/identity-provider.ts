import { Selectable } from "kysely";
import { JsonEncoded } from "../../../db";

const authMethods = [
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
  "private_key_jwt",
  "none",
] as const;

export type AuthMethod = typeof authMethods[number];

export const isAuthMethod = (s: string): s is AuthMethod =>
  authMethods.some((m) => s === m);

export type Endpoints = {
  authorization: string;
  token: string;
  userinfo: string | null;
};

export type Mappings = {
  sub: string;
  picture: string | null;
  email: string | null;
};

export type Metadata = {
  endpoints: Endpoints;
  mappings: Mappings;
  authMethods: Array<AuthMethod>;
  scopesSupported: Array<string>;
  codeChallengeMethods: Array<string>;
};

export interface IdentityProvider {
  id: string;
  name: string | null;
  icon: string | null;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  usePkce: number;
  discoverable: number;
  metadata: JsonEncoded<Metadata> | null;
}

export type IdentityProviderEntry = Selectable<IdentityProvider>;

export const tableName = "identity_provider";

export type PartialDB = { [tableName]: IdentityProvider };
