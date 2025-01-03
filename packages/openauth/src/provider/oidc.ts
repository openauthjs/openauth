import { createLocalJWKSet, JSONWebKeySet, jwtVerify } from "jose"
import { WellKnown } from "../client.js"
import { OauthError } from "../error.js"
import { Provider } from "./provider.js"
import { JWTPayload } from "hono/utils/jwt/types"
import { getRelativeUrl } from "../util.js"

export interface OidcConfig {
  type?: string
  clientID: string
  issuer: string
  scopes?: string[]
  query?: Record<string, string>
}

export type OidcWrappedConfig = Omit<OidcConfig, "issuer" | "name">

interface ProviderState {
  state: string
  nonce: string
  redirect: string
}

export interface IdTokenResponse {
  idToken: string
  claims: Record<string, any>
  raw: Record<string, any>
}

export function OidcProvider(
  config: OidcConfig,
): Provider<{ id: JWTPayload; clientID: string }> {
  const query = config.query || {}
  const scopes = config.scopes || []

  const wk = fetch(config.issuer + "/.well-known/openid-configuration").then(
    async (r) => {
      if (!r.ok) throw new Error(await r.text())
      return r.json() as Promise<WellKnown>
    },
  )

  const jwks = wk
    .then((r) => r.jwks_uri)
    .then(async (uri) => {
      const r = await fetch(uri)
      if (!r.ok) throw new Error(await r.text())
      return createLocalJWKSet((await r.json()) as JSONWebKeySet)
    })

  return {
    type: config.type || "oidc",
    init(routes, ctx) {
      routes.get("/authorize", async (c) => {
        const provider: ProviderState = {
          state: crypto.randomUUID(),
          nonce: crypto.randomUUID(),
          redirect: getRelativeUrl(c, "./callback"),
        }
        await ctx.set(c, "provider", 60 * 10, provider)
        const authorization = new URL(
          await wk.then((r) => r.authorization_endpoint),
        )
        authorization.searchParams.set("client_id", config.clientID)
        authorization.searchParams.set("response_type", "id_token")
        authorization.searchParams.set("response_mode", "form_post")
        authorization.searchParams.set("state", provider.state)
        authorization.searchParams.set("nonce", provider.nonce)
        authorization.searchParams.set("redirect_uri", provider.redirect)
        authorization.searchParams.set("scope", ["openid", ...scopes].join(" "))
        for (const [key, value] of Object.entries(query)) {
          authorization.searchParams.set(key, value)
        }
        return c.redirect(authorization.toString())
      })

      routes.post("/callback", async (c) => {
        const provider = await ctx.get<ProviderState>(c, "provider")
        if (!provider) return c.redirect(getRelativeUrl(c, "./authorize"))
        const body = await c.req.formData()
        const error = body.get("error")
        if (error)
          throw new OauthError(
            error.toString() as any,
            body.get("error_description")?.toString() || "",
          )
        const idToken = body.get("id_token")
        if (!idToken)
          throw new OauthError("invalid_request", "Missing id_token")
        const result = await jwtVerify(idToken.toString(), await jwks, {
          audience: config.clientID,
        })
        if (result.payload.nonce !== provider.nonce) {
          throw new OauthError("invalid_request", "Invalid nonce")
        }
        return ctx.success(c, {
          id: result.payload,
          clientID: config.clientID,
        })
      })
    },
  }
}
