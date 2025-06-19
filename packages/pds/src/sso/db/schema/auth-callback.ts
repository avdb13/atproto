import { Selectable } from "kysely"

export interface AuthCallback {
  idpId: string
  scopes: string,
  state: string,
  nonce: string,
  redirectUri: string,
  codeVerifier: string | null,
}

export type AuthCallbackEntry = Selectable<AuthCallback>

export const tableName = 'auth_callback'

export type PartialDB = { [tableName]: AuthCallback }
