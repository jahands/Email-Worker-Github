import { Toucan } from 'toucan-js'
import { Env } from './types'

let sentry: Toucan | undefined
export function getSentry(env: Env, ctx: ExecutionContext): Toucan {
	if (!sentry) {
		initSentry(env, ctx)
	}
	if (!sentry) throw new Error('unable to initSentry')
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
	const month = String(dt.getUTCMonth() + 1).padStart(2, '0')
	const day = String(dt.getUTCDay() + 1).padStart(2, '0')
	const hour = String(dt.getUTCHours() + 1).padStart(2, '0')
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

export function getTrimmedDisqusEmail(emailContent: ArrayBuffer): ArrayBuffer {
	const lines = new TextDecoder().decode(emailContent).split('\n')
	const startBoundaryIdx = lines.indexOf('Content-Type: text/html; charset="utf-8"\r')
	if (startBoundaryIdx === -1) {
		throw new Error('Could not find start boundary')
	}
	let endBoundary: string | undefined
	for (let i = lines.length - 1; i > startBoundaryIdx; i--) {
		const match = lines[i].match(/--=+([0-9])+=+--/)
		if (match) {
			endBoundary = match[0]
			break
		}
	}
	if (!endBoundary) {
		throw new Error('Could not find end boundary')
	}
	lines.splice(startBoundaryIdx - 1) // Remove the boundary itself and everything following
	lines.push(endBoundary) // Add the end boundary back in
	lines.push('\n')
	return new TextEncoder().encode(lines.join('\n'))
}
