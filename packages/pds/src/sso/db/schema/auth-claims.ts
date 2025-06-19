import { Selectable } from "kysely"

export interface AuthClaims {
  did: string
  idpId: string,
  sub: string,
  picture: string | null,
  email: string | null
}

export type AuthClaimsEntry = Selectable<AuthClaims>

export const tableName = 'auth_claims'

export type PartialDB = { [tableName]: AuthClaims }
