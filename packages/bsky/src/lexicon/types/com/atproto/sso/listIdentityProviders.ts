/**
 * GENERATED CODE - DO NOT MODIFY
 */
import express from 'express'
import { type ValidationResult, BlobRef } from '@atproto/lexicon'
import { CID } from 'multiformats/cid'
import { validate as _validate } from '../../../../lexicons'
import {
  type $Typed,
  is$typed as _is$typed,
  type OmitKey,
} from '../../../../util'
import { HandlerAuth, HandlerPipeThrough } from '@atproto/xrpc-server'

const is$typed = _is$typed,
  validate = _validate
const id = 'com.atproto.sso.listIdentityProviders'

export interface QueryParams {}

export type InputSchema = undefined

export interface OutputSchema {
  identityProviders: IdentityProvider[]
}

export type HandlerInput = undefined

export interface HandlerSuccess {
  encoding: 'application/json'
  body: OutputSchema
  headers?: { [key: string]: string }
}

export interface HandlerError {
  status: number
  message?: string
  error?: 'AccountTakedown'
}

export type HandlerOutput = HandlerError | HandlerSuccess | HandlerPipeThrough
export type HandlerReqCtx<HA extends HandlerAuth = never> = {
  auth: HA
  params: QueryParams
  input: HandlerInput
  req: express.Request
  res: express.Response
  resetRouteRateLimits: () => Promise<void>
}
export type Handler<HA extends HandlerAuth = never> = (
  ctx: HandlerReqCtx<HA>,
) => Promise<HandlerOutput> | HandlerOutput

export interface IdentityProvider {
  $type?: 'com.atproto.sso.listIdentityProviders#identityProvider'
  id: string
  name?: string
  icon?: string
}

const hashIdentityProvider = 'identityProvider'

export function isIdentityProvider<V>(v: V) {
  return is$typed(v, id, hashIdentityProvider)
}

export function validateIdentityProvider<V>(v: V) {
  return validate<IdentityProvider & V>(v, id, hashIdentityProvider)
}
