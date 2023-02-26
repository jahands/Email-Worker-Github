import { Toucan } from 'toucan-js'
import { Env } from './types'

export function getSentry(env: Env, ctx: ExecutionContext) {
	return new Toucan({
		dsn: env.SENTRY_DSN,
		context: ctx,
	});
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

export function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}