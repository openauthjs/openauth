import { Context } from "hono"
import { Provider } from "./provider.js"
import { generateUnbiasedDigits, timingSafeCompare } from "../random.js"

export type CodeProviderState =
  | {
      type: "start"
    }
  | {
      type: "code"
      resend?: boolean
      code: string
      claims: Record<string, string>
    }

export type CodeProviderError =
  | {
      type: "invalid_code"
    }
  | {
      type: "invalid_claim"
      key: string
      value: string
    }

export function CodeProvider<
  Claims extends Record<string, string> = Record<string, string>,
>(config: {
  length?: number
  request: (
    req: Request,
    state: CodeProviderState,
    form?: FormData,
    error?: CodeProviderError,
  ) => Promise<Response>
  sendCode: (claims: Claims, code: string) => Promise<void | CodeProviderError>
}) {
  const length = config.length || 6
  function generate() {
    return generateUnbiasedDigits(length)
  }

  return {
    type: "code",
    init(routes, ctx) {
      async function transition(
        c: Context,
        next: CodeProviderState,
        fd?: FormData,
        err?: CodeProviderError,
      ) {
        await ctx.set<CodeProviderState>(c, "provider", 60 * 60 * 24, next)
        const resp = ctx.forward(
          c,
          await config.request(c.req.raw, next, fd, err),
        )
        return resp
      }
      routes.get("/authorize", async (c) => {
        const resp = await transition(c, {
          type: "start",
        })
        return resp
      })

      routes.post("/authorize", async (c) => {
        const code = generate()
        const fd = await c.req.formData()
        const state = await ctx.get<CodeProviderState>(c, "provider")
        const action = fd.get("action")?.toString()

        if (action === "request" || action === "resend") {
          const claims = Object.fromEntries(fd) as Claims
          delete claims.action
          const err = await config.sendCode(claims, code)
          if (err) return transition(c, { type: "start" }, fd, err)
          return transition(
            c,
            {
              type: "code",
              resend: action === "resend",
              claims,
              code,
            },
            fd,
          )
        }

        if (
          fd.get("action")?.toString() === "verify" &&
          state.type === "code"
        ) {
          const fd = await c.req.formData()
          const compare = fd.get("code")?.toString()
          if (
            !state.code ||
            !compare ||
            !timingSafeCompare(state.code, compare)
          ) {
            return transition(
              c,
              {
                ...state,
                resend: false,
              },
              fd,
              { type: "invalid_code" },
            )
          }
          await ctx.unset(c, "provider")
          return ctx.forward(
            c,
            await ctx.success(c, { claims: state.claims as Claims }),
          )
        }
      })
    },
  } satisfies Provider<{ claims: Claims }>
}

export type CodeProviderOptions = Parameters<typeof CodeProvider>[0]
