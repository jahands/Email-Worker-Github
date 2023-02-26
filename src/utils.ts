import { Toucan } from 'toucan-js'
import { Env } from './types'

let sentry: Toucan | undefined
export function getSentry(env: Env, ctx: ExecutionContext): Toucan {
	if (!sentry) {
		initSentry(env, ctx)
	}
	if(!sentry) throw new Error('unable to initSentry')
	return sentry
}

export function initSentry(env: Env, ctx: ExecutionContext): Toucan {
	sentry = new Toucan({
		dsn: env.SENTRY_DSN,
		context: ctx,
	})
	return sentry
}

export function fixFilename(s: string): string {
	let filename = s.replace(/[^a-zA-Z0-9-_\[\]]+/g, " ")
	for (let i = 0; i < 10; i++) {
		filename = trimChar(filename, '-').trim()
		filename = trimChar(filename, '_').trim()
	}
	return filename
}

export function formatDate(dt: Date, ops: { hour: boolean } = { hour: true }): string {
	const year = dt.getUTCFullYear()
	const month = dt.getUTCMonth()
	const day = dt.getUTCDay()
	const hour = dt.getUTCHours()
	let fmt = `${year}/${month}/${day}`
	if (ops.hour) {
		fmt += `/${hour}`
	}
	return fmt
}

export function trimChar(str: string, ch: string) {
	var start = 0,
		end = str.length;
	while (start < end && str[start] === ch)
		++start;
	while (end > start && str[end - 1] === ch)
		--end;
	return (start > 0 || end < str.length) ? str.substring(start, end) : str;
}
