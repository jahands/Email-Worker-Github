import { Env } from "./types"

/** logtail sends logs to logtail.com */
export async function logtail(args: {
	env: Env,
	msg: string,
	level?: LogLevel,
	data?: any,
	e?: Error
}) {
	const { env, msg, level, data, e } = args
	if (e) {
		data.error = {
			message: e.message,
			stack: e.stack
		}
	}
	await fetch("https://in.logtail.com",
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
				...data
			})
		})
}

export enum LogLevel {
	Debug = "debug",
	Info = "info",
	Warn = "warn",
	Error = "error"
}
