/**
 * GENERATED CODE - DO NOT MODIFY
 */
import { HeadersMap, XRPCError } from '@atproto/xrpc'
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../lexicons'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../util'

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.admin.createIdentityProvider'

export interface QueryParams {}

export interface InputSchema {
  id: string
  name?: string
  icon?: string
  issuer: string
  clientId: string
  clientSecret: string
  scopes: string[]
  usePkce: boolean
  discoverable: boolean
  metadata?: Metadata
}

export interface OutputSchema {
  idpId: string
}

export interface CallOptions {
  signal?: AbortSignal
  headers?: HeadersMap
  qp?: QueryParams
  encoding?: 'application/json'
}

export interface Response {
  success: boolean
  headers: HeadersMap
  data: OutputSchema
}

export class IdentityProviderAlreadyExistsError extends XRPCError {
  constructor(src: XRPCError) {
    super(src.status, src.error, src.message, src.headers, { cause: src })
  }
}

export function toKnownErr(e: any) {
  if (e instanceof XRPCError) {
    if (e.error === 'IdentityProviderAlreadyExists')
      return new IdentityProviderAlreadyExistsError(e)
  }

  return e
}

export type AuthMethods =
  | 'client_secret_basic'
  | 'client_secret_post'
  | 'client_secret_jwt'
  | 'private_key_jwt'
  | 'none'
  | (string & {})[]

export interface Endpoints {
  $type?: 'com.atproto.admin.createIdentityProvider#endpoints'
  authorization: string
  token: string
  userInfo?: string
}

const hashEndpoints = 'endpoints'

export function isEndpoints<V>(v: V) {
  return is$typed(v, id, hashEndpoints)
}

export function validateEndpoints<V>(v: V) {
  return validate<Endpoints & V>(v, id, hashEndpoints)
}

export interface Mappings {
  $type?: 'com.atproto.admin.createIdentityProvider#mappings'
  sub: string
  picture?: string
  email?: string
}

const hashMappings = 'mappings'

export function isMappings<V>(v: V) {
  return is$typed(v, id, hashMappings)
}

export function validateMappings<V>(v: V) {
  return validate<Mappings & V>(v, id, hashMappings)
}

export interface Metadata {
  $type?: 'com.atproto.admin.createIdentityProvider#metadata'
  endpoints: Endpoints
  mappings: Mappings
  authMethods: AuthMethods[]
  scopesSupported: string[]
  codeChallengeMethods?: string[]
}

const hashMetadata = 'metadata'

export function isMetadata<V>(v: V) {
  return is$typed(v, id, hashMetadata)
}

export function validateMetadata<V>(v: V) {
  return validate<Metadata & V>(v, id, hashMetadata)
}
