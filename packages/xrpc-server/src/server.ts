import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import express, {
  Application,
  ErrorRequestHandler,
  Express,
  NextFunction,
  Request,
  RequestHandler,
  Response,
  Router,
  json as jsonParser,
  text as textParser,
} from 'express'
import { check, schema } from '@atproto/common'
import {
  LexXrpcProcedure,
  LexXrpcQuery,
  LexXrpcSubscription,
  LexiconDoc,
  Lexicons,
  lexToJson,
} from '@atproto/lexicon'
import log, { LOGGER_NAME } from './logger'
import { consumeMany, resetMany } from './rate-limiter'
import { ErrorFrame, Frame, MessageFrame, XrpcStreamServer } from './stream'
import {
  AuthVerifier,
  HandlerAuth,
  HandlerPipeThrough,
  HandlerSuccess,
  InternalServerError,
  InvalidRequestError,
  MethodNotImplementedError,
  Options,
  Params,
  RateLimitExceededError,
  RateLimiterI,
  XRPCError,
  XRPCHandler,
  XRPCHandlerConfig,
  XRPCReqContext,
  XRPCStreamHandler,
  XRPCStreamHandlerConfig,
  isHandlerError,
  isHandlerPipeThroughBuffer,
  isHandlerPipeThroughStream,
  isShared,
} from './types'
import {
  decodeQueryParams,
  getQueryParams,
  validateInput,
  validateOutput,
} from './util'

export function createServer(lexicons?: LexiconDoc[], options?: Options) {
  return new Server(lexicons, options)
}

export class Server {
  router: Express = express()
  routes: Router = Router()
  subscriptions = new Map<string, XrpcStreamServer>()
  lex = new Lexicons()
  options: Options
  middleware: Record<'json' | 'text', RequestHandler>
  globalRateLimiters: RateLimiterI[]
  sharedRateLimiters: Record<string, RateLimiterI>
  routeRateLimiters: Record<string, RateLimiterI[]>

  constructor(lexicons?: LexiconDoc[], opts: Options = {}) {
    if (lexicons) {
      this.addLexicons(lexicons)
    }
    this.router.use(this.routes)
    this.router.use('/xrpc/:methodId', this.catchall.bind(this))
    this.router.use(createErrorMiddleware(opts))
    this.router.once('mount', (app: Application) => {
      this.enableStreamingOnListen(app)
    })
    this.options = opts
    this.middleware = {
      json: jsonParser({ limit: opts?.payload?.jsonLimit }),
      text: textParser({ limit: opts?.payload?.textLimit }),
    }
    this.globalRateLimiters = []
    this.sharedRateLimiters = {}
    this.routeRateLimiters = {}
    if (opts?.rateLimits?.global) {
      for (const limit of opts.rateLimits.global) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        })
        this.globalRateLimiters.push(rateLimiter)
      }
    }
    if (opts?.rateLimits?.shared) {
      for (const limit of opts.rateLimits.shared) {
        const rateLimiter = opts.rateLimits.creator({
          ...limit,
          keyPrefix: `rl-${limit.name}`,
        })
        this.sharedRateLimiters[limit.name] = rateLimiter
      }
    }
  }

  // handlers
  // =

  method(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    this.addMethod(nsid, configOrFn)
  }

  addMethod(nsid: string, configOrFn: XRPCHandlerConfig | XRPCHandler) {
    const config =
      typeof configOrFn === 'function' ? { handler: configOrFn } : configOrFn
    const def = this.lex.getDef(nsid)
    if (def?.type === 'query' || def?.type === 'procedure') {
      this.addRoute(nsid, def, config)
    } else {
      throw new Error(`Lex def for ${nsid} is not a query or a procedure`)
    }
  }

  streamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    this.addStreamMethod(nsid, configOrFn)
  }

  addStreamMethod(
    nsid: string,
    configOrFn: XRPCStreamHandlerConfig | XRPCStreamHandler,
  ) {
    const config =
      typeof configOrFn === 'function' ? { handler: configOrFn } : configOrFn
    const def = this.lex.getDef(nsid)
    if (def?.type === 'subscription') {
      this.addSubscription(nsid, def, config)
    } else {
      throw new Error(`Lex def for ${nsid} is not a subscription`)
    }
  }

  // schemas
  // =

  addLexicon(doc: LexiconDoc) {
    this.lex.add(doc)
  }

  addLexicons(docs: LexiconDoc[]) {
    for (const doc of docs) {
      this.addLexicon(doc)
    }
  }

  // http
  // =

  protected async addRoute(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    config: XRPCHandlerConfig,
  ) {
    const verb: 'post' | 'get' = def.type === 'procedure' ? 'post' : 'get'
    const middleware: RequestHandler[] = []
    middleware.push(createLocalsMiddleware(nsid))
    if (config.auth) {
      middleware.push(createAuthMiddleware(config.auth))
    }
    if (verb === 'post') {
      middleware.push(this.middleware.json)
      middleware.push(this.middleware.text)
    }
    this.setupRouteRateLimits(nsid, config)
    this.routes[verb](
      `/xrpc/${nsid}`,
      ...middleware,
      this.createHandler(nsid, def, config),
    )
  }

  async catchall(req: Request, res: Response, next: NextFunction) {
    if (this.globalRateLimiters) {
      try {
        const rlRes = await consumeMany(
          {
            req,
            res,
            auth: undefined,
            params: {},
            input: undefined,
            async resetRouteRateLimits() {},
          },
          this.globalRateLimiters.map(
            (rl) => (ctx: XRPCReqContext) => rl.consume(ctx),
          ),
        )
        if (rlRes instanceof RateLimitExceededError) {
          return next(rlRes)
        }
      } catch (err) {
        return next(err)
      }
    }

    // Ensure that known XRPC methods are only called with the correct HTTP
    // method.
    const def = this.lex.getDef(req.params.methodId)
    if (def) {
      const expectedMethod =
        def.type === 'procedure' ? 'POST' : def.type === 'query' ? 'GET' : null
      if (expectedMethod != null && expectedMethod !== req.method) {
        return next(
          new InvalidRequestError(
            `Incorrect HTTP method (${req.method}) expected ${expectedMethod}`,
          ),
        )
      }
    }

    if (this.options.catchall) {
      this.options.catchall.call(null, req, res, next)
    } else if (!def) {
      next(new MethodNotImplementedError())
    } else {
      next()
    }
  }

  createHandler(
    nsid: string,
    def: LexXrpcQuery | LexXrpcProcedure,
    routeCfg: XRPCHandlerConfig,
  ): RequestHandler {
    const routeOpts = {
      blobLimit: routeCfg.opts?.blobLimit ?? this.options.payload?.blobLimit,
    }
    const validateReqInput = (req: Request) =>
      validateInput(nsid, def, req, routeOpts, this.lex)
    const validateResOutput =
      this.options.validateResponse === false
        ? null
        : (output: undefined | HandlerSuccess) =>
            validateOutput(nsid, def, output, this.lex)
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params)
    const rls = this.routeRateLimiters[nsid] ?? []
    const consumeRateLimit = (reqCtx: XRPCReqContext) =>
      consumeMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.consume(ctx)),
      )

    const resetRateLimit = (reqCtx: XRPCReqContext) =>
      resetMany(
        reqCtx,
        rls.map((rl) => (ctx: XRPCReqContext) => rl.reset(ctx)),
      )

    return async function (req, res, next) {
      try {
        // validate request
        let params = decodeQueryParams(def, req.query)
        try {
          params = assertValidXrpcParams(params) as Params
        } catch (e) {
          throw new InvalidRequestError(String(e))
        }
        const input = validateReqInput(req)

        const locals: RequestLocals = req[kRequestLocals]

        const reqCtx: XRPCReqContext = {
          params,
          input,
          auth: locals.auth,
          req,
          res,
          resetRouteRateLimits: async () => resetRateLimit(reqCtx),
        }

        // handle rate limits
        const result = await consumeRateLimit(reqCtx)
        if (result instanceof RateLimitExceededError) {
          return next(result)
        }

        // run the handler
        const output = await routeCfg.handler(reqCtx)

        if (!output) {
          validateResOutput?.(output)
          res.status(200)
          res.end()
        } else if (isHandlerPipeThroughStream(output)) {
          setHeaders(res, output)
          res.status(200)
          res.header('Content-Type', output.encoding)
          await pipeline(output.stream, res)
        } else if (isHandlerPipeThroughBuffer(output)) {
          setHeaders(res, output)
          res.status(200)
          res.header('Content-Type', output.encoding)
          res.end(output.buffer)
        } else if (isHandlerError(output)) {
          next(XRPCError.fromError(output))
        } else {
          validateResOutput?.(output)

          res.status(200)
          setHeaders(res, output)

          if (
            output.encoding === 'application/json' ||
            output.encoding === 'json'
          ) {
            const json = lexToJson(output.body)
            res.json(json)
          } else if (output.body instanceof Readable) {
            res.header('Content-Type', output.encoding)
            await pipeline(output.body, res)
          } else {
            res.header('Content-Type', output.encoding)
            res.send(
              Buffer.isBuffer(output.body)
                ? output.body
                : output.body instanceof Uint8Array
                  ? Buffer.from(output.body)
                  : output.body,
            )
          }
        }
      } catch (err: unknown) {
        // Express will not call the next middleware (errorMiddleware in this case)
        // if the value passed to next is false-y (e.g. null, undefined, 0).
        // Hence we replace it with an InternalServerError.
        if (!err) {
          next(new InternalServerError())
        } else {
          next(err)
        }
      }
    }
  }

  protected async addSubscription(
    nsid: string,
    def: LexXrpcSubscription,
    config: XRPCStreamHandlerConfig,
  ) {
    const assertValidXrpcParams = (params: unknown) =>
      this.lex.assertValidXrpcParams(nsid, params)
    this.subscriptions.set(
      nsid,
      new XrpcStreamServer({
        noServer: true,
        handler: async function* (req, signal) {
          try {
            // authenticate request
            const auth = await config.auth?.({ req })
            if (isHandlerError(auth)) {
              throw XRPCError.fromHandlerError(auth)
            }
            // validate request
            let params = decodeQueryParams(def, getQueryParams(req.url))
            try {
              params = assertValidXrpcParams(params) as Params
            } catch (e) {
              throw new InvalidRequestError(String(e))
            }
            // stream
            const items = config.handler({ req, params, auth, signal })
            for await (const item of items) {
              if (item instanceof Frame) {
                yield item
                continue
              }
              const type = item?.['$type']
              if (!check.is(item, schema.map) || typeof type !== 'string') {
                yield new MessageFrame(item)
                continue
              }
              const split = type.split('#')
              let t: string
              if (
                split.length === 2 &&
                (split[0] === '' || split[0] === nsid)
              ) {
                t = `#${split[1]}`
              } else {
                t = type
              }
              const clone = { ...item }
              delete clone['$type']
              yield new MessageFrame(clone, { type: t })
            }
          } catch (err) {
            const xrpcErrPayload = XRPCError.fromError(err).payload
            yield new ErrorFrame({
              error: xrpcErrPayload.error ?? 'Unknown',
              message: xrpcErrPayload.message,
            })
          }
        },
      }),
    )
  }

  private enableStreamingOnListen(app: Application) {
    const _listen = app.listen
    app.listen = (...args) => {
      // @ts-ignore the args spread
      const httpServer = _listen.call(app, ...args)
      httpServer.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '', 'http://x')
        const sub = url.pathname.startsWith('/xrpc/')
          ? this.subscriptions.get(url.pathname.replace('/xrpc/', ''))
          : undefined
        if (!sub) return socket.destroy()
        sub.wss.handleUpgrade(req, socket, head, (ws) =>
          sub.wss.emit('connection', ws, req),
        )
      })
      return httpServer
    }
  }

  private setupRouteRateLimits(nsid: string, config: XRPCHandlerConfig) {
    this.routeRateLimiters[nsid] = []
    for (const limit of this.globalRateLimiters) {
      this.routeRateLimiters[nsid].push({
        consume: (ctx: XRPCReqContext) => limit.consume(ctx),
        reset: (ctx: XRPCReqContext) => limit.reset(ctx),
      })
    }

    if (config.rateLimit) {
      const limits = Array.isArray(config.rateLimit)
        ? config.rateLimit
        : [config.rateLimit]
      this.routeRateLimiters[nsid] = []
      for (let i = 0; i < limits.length; i++) {
        const limit = limits[i]
        const { calcKey, calcPoints } = limit
        if (isShared(limit)) {
          const rateLimiter = this.sharedRateLimiters[limit.name]
          if (rateLimiter) {
            this.routeRateLimiters[nsid].push({
              consume: (ctx: XRPCReqContext) =>
                rateLimiter.consume(ctx, {
                  calcKey,
                  calcPoints,
                }),
              reset: (ctx: XRPCReqContext) =>
                rateLimiter.reset(ctx, {
                  calcKey,
                }),
            })
          }
        } else {
          const { durationMs, points } = limit
          const rateLimiter = this.options.rateLimits?.creator({
            keyPrefix: `nsid-${i}`,
            durationMs,
            points,
            calcKey,
            calcPoints,
          })
          if (rateLimiter) {
            this.sharedRateLimiters[nsid] = rateLimiter
            this.routeRateLimiters[nsid].push({
              consume: (ctx: XRPCReqContext) =>
                rateLimiter.consume(ctx, {
                  calcKey,
                  calcPoints,
                }),
              reset: (ctx: XRPCReqContext) =>
                rateLimiter.reset(ctx, {
                  calcKey,
                }),
            })
          }
        }
      }
    }
  }
}

function setHeaders(
  res: Response,
  result: HandlerSuccess | HandlerPipeThrough,
) {
  const { headers } = result
  if (headers) {
    for (const [name, val] of Object.entries(headers)) {
      if (val != null) res.header(name, val)
    }
  }
}

const kRequestLocals = Symbol('requestLocals')

function createLocalsMiddleware(nsid: string): RequestHandler {
  return function (req, _res, next) {
    const locals: RequestLocals = { auth: undefined, nsid }
    req[kRequestLocals] = locals
    return next()
  }
}

type RequestLocals = {
  auth: HandlerAuth | undefined
  nsid: string
}

function createAuthMiddleware(verifier: AuthVerifier): RequestHandler {
  return async function (req, res, next) {
    try {
      const result = await verifier({ req, res })
      if (isHandlerError(result)) {
        throw XRPCError.fromHandlerError(result)
      }
      const locals: RequestLocals = req[kRequestLocals]
      locals.auth = result
      next()
    } catch (err: unknown) {
      next(err)
    }
  }
}

function createErrorMiddleware({
  errorParser = (err) => XRPCError.fromError(err),
}: Options): ErrorRequestHandler {
  return (err, req, res, next) => {
    const locals: RequestLocals | undefined = req[kRequestLocals]
    const methodSuffix = locals ? ` method ${locals.nsid}` : ''

    const xrpcError = errorParser(err)

    // Use the request's logger (if available) to benefit from request context
    // (id, timing) and logging configuration (serialization, etc.).
    const logger = isPinoHttpRequest(req) ? req.log : log

    const isInternalError = xrpcError instanceof InternalServerError

    logger.error(
      {
        // @NOTE Computation of error stack is an expensive operation, so
        // we strip it for expected errors.
        err:
          isInternalError || process.env.NODE_ENV === 'development'
            ? err
            : toSimplifiedErrorLike(err),

        // XRPC specific properties, for easier browsing of logs
        nsid: locals?.nsid,
        type: xrpcError.type,
        status: xrpcError.statusCode,
        payload: xrpcError.payload,

        // Ensure that the logged item's name is set to LOGGER_NAME, instead of
        // the name of the pino-http logger, to ensure consistency across logs.
        name: LOGGER_NAME,
      },
      isInternalError
        ? `unhandled exception in xrpc${methodSuffix}`
        : `error in xrpc${methodSuffix}`,
    )

    if (res.headersSent) {
      return next(err)
    }

    return res.status(xrpcError.statusCode).json(xrpcError.payload)
  }
}

function isPinoHttpRequest(req: Request): req is Request & {
  log: { error: (obj: unknown, msg: string) => void }
} {
  return typeof (req as { log?: any }).log?.error === 'function'
}

function toSimplifiedErrorLike(err: unknown): unknown {
  if (err instanceof Error) {
    // Transform into an "ErrorLike" for pino's std "err" serializer
    return {
      ...err,
      // Carry over non-enumerable properties
      message: err.message,
      name:
        !Object.hasOwn(err, 'name') &&
        Object.prototype.toString.call(err.constructor) === '[object Function]'
          ? err.constructor.name // extract the class name for sub-classes of Error
          : err.name,
      // @NOTE Error.stack, Error.cause and AggregateError.error are non
      // enumerable properties so they won't be spread to the ErrorLike
    }
  }

  return err
}
