import { Env } from "./types"
import { getSentry } from "./utils"

/** logtail sends logs to logtail.com and Sentry (except for Debug logs) */
export function logtail(args: {
	env: Env,
	ctx: ExecutionContext,
	msg: string,
	level?: LogLevel,
	data?: any,
	e?: Error,
	useSentry?: boolean,
}) {
	let { env, ctx, msg, level, data, e, useSentry } = args
	if (!data) data = {}
	
	if (useSentry === undefined) {
		if (level === LogLevel.Debug) {
			useSentry = false
		} else {
			useSentry = true
		}
	}

	const sentry = getSentry(env, ctx)
	if (useSentry) {
		sentry.setExtra('msg', msg)
		sentry.setExtra('data', data)
		if (level) {
			sentry.setTag('level', level)
		}
	}

	if (e) {
		if (useSentry) {
			sentry.captureException(e, {
				data: {
					msg,
					...data
				}
			})
		}
		if (!level) {
			level = LogLevel.Error
		}

		data.error = e
	} else {
		if (useSentry) {
			sentry.captureMessage(msg, level || LogLevel.Info, { data })
		}
	}
	ctx.waitUntil(fetch("https://in.logtail.com",
		{
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${env.LOGTAIL_KEY}`
			},
			body: JSON.stringify({
				dt: new Date().toISOString(),
				level: level || LogLevel.Info,
				message: msg,
				env: env.ENVIRONMENT,
				...data,
				useSentry,
			})
		}))
}

export enum LogLevel {
	Debug = "debug",
	Info = "info",
	Warning = "warning",
	Error = "error",
	Fatal = "fatal",
	Log = "log"
}
