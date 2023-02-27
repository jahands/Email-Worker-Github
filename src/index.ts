import pRetry, { AbortError } from 'p-retry';
import { ThrottledQueue } from '@jahands/msc-utils'
import { AwsClient } from 'aws4fetch'
import { LogLevel, logtail } from './logtail';

import { QueueData, Env } from "./types";
import { fixFilename, formatDate, initSentry } from './utils';

const AETYPES = {
	Msc: 'msc',
	Github: 'github',
	Disqus: 'disqus',
	Blogtrottr: 'blogtrottr'
} as const

const throttleQueue = new ThrottledQueue({ concurrency: 1, interval: 5000, limit: 5 });

export default {
	async email(message: EmailMessage, env: Env, ctx: ExecutionContext) {
		initSentry(env, ctx)
		try {
			await handleEmail(message, env, ctx)
		} catch (e) {
			if (e instanceof Error) {
				logtail({
					env, ctx, e, msg: 'Error handling email: ' + e.message,
					level: LogLevel.Error,
					data: {
						email: {
							to: message.to || '',
							from: message.from || ''
						},
					}
				})
				throw e
			}
		}
	},

	async queue(batch: MessageBatch<QueueData>, env: Env, ctx: ExecutionContext) {
		initSentry(env, ctx)
		try {
			await handleQueue(batch, env)
		} catch (e) {
			if (e instanceof Error) {
				logtail({
					env, ctx, e, msg: 'Error handling queue: ' + e.message,
					level: LogLevel.Error,
					data: {
						batch,
						retriesLeft: e
					}
				})
				throw e
			}
		}
	},
}

async function handleEmail(message: EmailMessage, env: Env, ctx: ExecutionContext): Promise<void> {
	const now = Date.now()
	let allAEType: string = AETYPES.Msc
	const subject = message.headers.get('subject') || ''
	await pRetry(async () => await env.QUEUE.send({
		ts: now,
		from: message.from,
		to: message.to,
		subject: subject
	}), {
		retries: 3, minTimeout: 100, onFailedAttempt: async (e) => {
			logtail({
				env, ctx, e, msg: 'Failed to send to Queue: ' + e.message,
				level: LogLevel.Error,
				data: {
					retriesLeft: e.retriesLeft,
					subject,
					to: message.to,
					from: message.from,
				}
			})
		}
	})

	if (['noreply@github.com',
		'notifications@github.com'].includes(message.from)
		|| message.from.endsWith('@sgmail.github.com')) {
		allAEType = AETYPES.Github
		// Write some stats to AE
		try {
			const { org, project } = getProjectInfo(subject)
			env.STATS.writeDataPoint({
				blobs: [org, project],
				doubles: [1, message.rawSize],
				indexes: [org]
			})
			try {
				ctx.waitUntil(saveEmailToB2(env, ctx, message,
					`github/${message.from}/${org}/${project}`, now))
			} catch (e) { console.log(e) }
		} catch (e) {
			console.log(`Unable to find project info in: ${subject}\n${e}`)
		}
	} else {
		let from = message.from
		// Some from's are super spammy, so we fix thejm up a bit
		if (from.endsWith('@alerts.bounces.google.com')) {
			from = `REDACTED@alerts.bounces.google.com`
		} else if (from.endsWith('@hamfrj.shared.klaviyomail.com')) {
			from = `REDACTED@hamfrj.shared.klaviyomail.com`
		} else if (from.endsWith('@a464845.bnc3.mailjet.com')) {
			from = `REDACTED@a464845.bnc3.mailjet.com`
		} else if (from.endsWith('.discoursemail.com')) {
			from = `REDACTED@${from.split('@')[1]}`
		}

		const folder = `to/${message.to}/from/${from}`
		ctx.waitUntil(saveEmailToB2(env, ctx, message, folder, now))
	}
	if (message.from === 'notifications@disqus.net') {
		allAEType = AETYPES.Disqus
	} else if (message.to === 'blogtrottr-bulk@eemailme.com') {
		allAEType = AETYPES.Blogtrottr
	}
	env.ALLSTATS.writeDataPoint({
		blobs: [allAEType, message.to],
		doubles: [1, message.rawSize],
		indexes: [message.to]
	})
	// const today = new Date();
	// let forwardChance = 0.1 // 10%
	// if (today.getDay() === 6 || today.getDay() === 0) {
	// 	forwardChance = 0.3 // 30% on weekends
	// }
	if (message.from.includes('github.com') && subject.includes('Please verify your email address.')) {
		await message.forward('jacob@jacobhands.com')
	}
	if (message.to.includes('producthunt.com@eemailme.com')) {
		// await message.forward('jacob@jacobhands.com')
	}
}

async function handleQueue(batch: MessageBatch<QueueData>, env: Env): Promise<void> {
	// Extract the body from each message.
	// Metadata is also available, such as a message id and timestamp.
	const messages: QueueData[] = batch.messages.map((msg) => msg.body)
	// for (const msg of messages) {
	// 	throttleQueue.add(() => sendHook(`**To:** ${msg.to} • **From:** ${msg.from} • <t:${Math.round(msg.ts / 1000)}:f>\n**Subject:** ${msg.subject}`, env))
	// }
	const content = messages.map(msg => `**To:** ${msg.to} • **From:** ${msg.from} • <t:${Math.round(msg.ts / 1000)}:f>\n**Subject:** ${msg.subject}`)
	let next = ''
	for (let i = 0; i < content.length; i++) {
		// +1 is for the \n we prepend in the else{}
		if ((next.length + content[i].length) + 1 > 4096) {
			throttleQueue.add(() => sendHook(next, env))
			next = ''
		} else {
			next += `\n${content[i]}`
		}
	}
	if (next.length > 0) {
		throttleQueue.add(() => sendHook(next, env))
	}
	await throttleQueue.onIdle()
}

async function sendHook(content: string, env: Env): Promise<void> {
	const res = await fetch(env.DISCORDHOOK, {
		body: JSON.stringify({ content }),
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		}
	})
	console.log(res.status)
}

function getProjectInfo(s: string): { org: string, project: string } {
	const firstIndex = s.indexOf('[')
	const lastIndex = s.indexOf(']')
	if (firstIndex === -1 || lastIndex === -1) {
		throw new Error('unable to find project info')
	}
	const orgAndProject = s.substring(firstIndex + 1, lastIndex).split('/')
	const [org, project] = orgAndProject
	return { org, project }
}

async function saveEmailToB2(env: Env, ctx: ExecutionContext, message: EmailMessage, folder: string, now: number): Promise<Response> {
	const aws = new AwsClient({
		"accessKeyId": env.B2_AWS_ACCESS_KEY_ID,
		"secretAccessKey": env.B2_AWS_SECRET_ACCESS_KEY,
		"region": env.B2_AWS_DEFAULT_REGION,
		"service": "s3"
	});
	const subject = message.headers.get('subject') || ''
	const dateHeader = message.headers.get('Date')
	const dt = dateHeader ? new Date(dateHeader) : new Date()
	const dtFormat = formatDate(dt, { hour: false })
	let filename = fixFilename(subject).trim()
	if (!filename || filename === '') {
		filename = `NOSUBJECT_${crypto.randomUUID()}`
	}
	const suffix = `.${now}.eml`
	// Max length of a file on linux is 255, so we want to limit the last
	// segment length.
	const filenameWithSuffixLength = `${filename}${suffix}`.length
	if (filenameWithSuffixLength > 255) {
		const amountToTrim = 255 - suffix.length
		filename = filename.substr(0, filename.length - amountToTrim)
	}

	let b2Key = `${folder}/${dtFormat}/${filename}`
	const maxLength = 1024 - suffix.length
	// s3 paths are max 1024 characters
	if (b2Key.length > maxLength) {
		b2Key = b2Key.substr(0, maxLength - 1) // -1 in case of off-by-one
	}
	b2Key += suffix

	const emailContent = await new Response(message.raw).arrayBuffer();

	let tries = 0
	let success = false
	while (!success && tries < 3) {
		tries++
		if (tries > 1) {
			await scheduler.wait(1000 * tries)
		}
		try {
			await env.R2.put(b2Key, emailContent, {
				customMetadata: {
					to: message.to,
					from: message.from,
					subject: subject
				}
			})
			success = true

			await pRetry(async () => await env.DISCORDEMBED.send({
				from: message.from,
				subject: subject,
				to: message.to,
				r2path: b2Key,
				ts: dt.getTime()
			}), {
				retries: 3, minTimeout: 100, onFailedAttempt: async (e) => {
					logtail({
						env, ctx, e, msg: 'Failed to send to Queue: ' + e.message,
						level: LogLevel.Error,
						data: {
							retriesLeft: e.retriesLeft,
							subject,
							to: message.to,
							from: message.from,
						}
					})

				}
			})
		} catch (e) {
			console.log('failed to save to R2', e)
			if (e instanceof Error) {
				logtail({
					env, ctx, e, msg: e.message,
					level: LogLevel.Error,
					data: {
						b2Key,
						subject,
						to: message.to,
						from: message.from,
						emailLength: emailContent.toString().length,
					}
				})
			}
		}
	}
	if (!success) {
		logtail({
			env, ctx, msg: `Failed to save to R2 after retries :(`,
			level: LogLevel.Warn,
			data: {
				b2Key,
				subject,
				to: message.to,
				from: message.from,
				emailLength: emailContent.toString().length,
			}
		})
	}
	tries = 0
	let res: Response | undefined
	while (tries < 3) {
		tries++
		res = await aws.fetch(`${env.B2_ENDPOINT}/${encodeURIComponent(b2Key)}`, {
			method: 'PUT',
			body: emailContent
		})
		if (res.ok) {
			return res
		} else {
			logtail({
				env, ctx, msg: `Failed to save to B2! ${res.status} - ${res.statusText}`,
				level: LogLevel.Warn,
				data: {
					b2Key,
					subject,
					to: message.to,
					from: message.from,
					emailLength: emailContent.toString().length,
					res: {
						status: res.status,
						statusText: res.statusText,
						body: await res.clone().text()
					}
				}
			})
		}
	}
	if (res) {
		logtail({
			env, ctx, msg: `Failed to save to B2! ${res.status} - ${res.statusText}`,
			level: LogLevel.Warn,
			data: {
				b2Key,
				subject,
				to: message.to,
				from: message.from,
				emailLength: emailContent.toString().length,
				res: {
					status: res.status,
					statusText: res.statusText,
					body: await res.clone().text()
				}
			}
		})
	}
	throw new Error('Failed to save to B2')
}
