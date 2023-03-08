import pRetry, { AbortError } from 'p-retry';
import { ThrottledQueue } from '@jahands/msc-utils'
import { AwsClient } from 'aws4fetch'
import { LogLevel, logtail } from './logtail';

import { QueueData, Env } from "./types";
import { fixFilename, formatDate, getTrimmedDisqusEmail, initSentry } from './utils';

const AETYPES = {
	Msc: 'msc',
	Github: 'github',
	Disqus: 'disqus',
	Blogtrottr: 'blogtrottr'
} as const

const throttleQueue = new ThrottledQueue({ concurrency: 1, interval: 1200, limit: 1 });

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
			await handleQueue(batch, env, ctx)
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



	try {
		await pRetry(async () => await env.QUEUE.send({
			ts: now,
			from: message.from,
			to: message.to,
			subject: subject
		}), {
			retries: 5, minTimeout: 250, onFailedAttempt: async (e) => {
				if (e.retriesLeft === 0) {
					logtail({
						env, ctx, e, msg: 'Failed to send to Queue, giving up: ' + e.message,
						level: LogLevel.Error,
						data: {
							queue: 'QUEUE',
							attemptNumber: e.attemptNumber,
							retriesLeft: e.retriesLeft,
							subject,
							to: message.to,
							from: message.from,
						}
					})
				} else {
					logtail({
						env, ctx, e, msg: 'Failed to send to Queue, retrying: ' + e.message,
						level: LogLevel.Warning,
						data: {
							queue: 'QUEUE',
							attemptNumber: e.attemptNumber,
							retriesLeft: e.retriesLeft,
							subject,
							to: message.to,
							from: message.from,
						}
					})
					if (e.message.includes('Queue is overloaded. Please back off.')) {
						await scheduler.wait(1000 * e.attemptNumber)
					}
				}
			}
		})
	} catch { } // Logged above, ignore

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
}

async function handleQueue(batch: MessageBatch<QueueData>, env: Env, ctx: ExecutionContext): Promise<void> {
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
		const email = content[i].substring(0, 1999) // Discord has a 2000 char limit
		if ((next.length + email.length + 1) > 2000) {
			throttleQueue.add(() => sendHook(next, env, ctx))
			next = ''
		} else {
			next += `\n${email}`
		}
	}
	if (next.length > 0) {
		throttleQueue.add(() => sendHook(next, env, ctx))
	}
	await throttleQueue.onIdle()
}

async function sendHook(content: string, env: Env, ctx: ExecutionContext): Promise<void> {
	if (!content || content.length === 0 || content === '\n') return
	const res = await fetch(env.DISCORDHOOK, {
		body: JSON.stringify({ content }),
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		}
	})
	if (!res.ok) {
		logtail({
			env, ctx, msg: 'Failed to send hook',
			level: LogLevel.Error,
			data: {
				status: res.status,
				statusText: res.statusText,
				body: await res.text()
			}
		})
	}
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

async function saveEmailToB2(env: Env, ctx: ExecutionContext, message: EmailMessage, folder: string, now: number): Promise<void> {
	const aws = new AwsClient({
		accessKeyId: env.B2_AWS_ACCESS_KEY_ID,
		secretAccessKey: env.B2_AWS_SECRET_ACCESS_KEY,
		region: env.B2_AWS_DEFAULT_REGION,
		service: "s3"
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
		filename = filename.substring(0, filename.length - amountToTrim)
	}

	let b2Key = `${folder}/${dtFormat}/${filename}`
	const maxLength = 1024 - suffix.length
	// s3 paths are max 1024 characters
	if (b2Key.length > maxLength) {
		b2Key = b2Key.substring(0, maxLength - 1) // -1 in case of off-by-one
	}
	b2Key += suffix

	const govIDBlocklist = ['fbi@subscriptions.fbi.gov', 'no-reply@civicplus.com', 'listserv@civicplus.com']
	let shouldCheckGovDelivery = false
	if (message.to === 'usa-gov-lists@eemailme.com' && !govIDBlocklist.includes(message.from)) {
		shouldCheckGovDelivery = true
		const govDeliveryId = message.headers.get('x-accountcode')
		console.log({ govDeliveryId })
		if (govDeliveryId) {
			const id = govDeliveryId.trim().toUpperCase()
			env.GOVDELIVERY.writeDataPoint({
				blobs: [id],
				doubles: [1],
				indexes: [id]
			})
			shouldCheckGovDelivery = false
		}
	}

	let emailContent = await new Response(message.raw).arrayBuffer();
	if (message.from === 'notifications@disqus.net') {
		// Disqus emails have a ton of css that we don't want to store, get rid of it!
		try {
			const trimmedEmail = getTrimmedDisqusEmail(emailContent)

			const originalLength = emailContent.byteLength
			const trimmedLength = trimmedEmail.byteLength

			emailContent = trimmedEmail
			// Record saved space
			const savedSpace = originalLength - trimmedLength
			env.DISQUS_SAVED_SPACE.writeDataPoint({
				blobs: ['bytes'],
				doubles: [savedSpace],
				indexes: ['bytes']
			})
		} catch (e) {
			if (e instanceof Error) {
				logtail({
					env, ctx, e, msg: 'Failed to trim disqus email',
					level: LogLevel.Error,
					data: {
						subject,
						to: message.to,
						from: message.from,
						emailContent
					}
				})
			}
		}
	}

	const putR2 = async () => pRetry(async () => await env.R2.put(b2Key, emailContent, {
		customMetadata: {
			to: message.to,
			from: message.from,
			subject: subject.substring(0, 255)
		}
	}), {
		retries: 10, minTimeout: 250, onFailedAttempt: async (e) => {
			if (e.retriesLeft === 0) {
				logtail({
					env, ctx, e, msg: 'Failed to save to R2, giving up: ' + e.message,
					level: LogLevel.Error,
					data: {
						retriesLeft: e.retriesLeft,
						attemptNumber: e.attemptNumber,
						subject,
						to: message.to,
						from: message.from,
					}
				})
			}
		}
	})

	const putB2 = async () => {
		const res = await aws.fetch(`${env.B2_ENDPOINT}/${encodeURIComponent(b2Key)}`, {
			method: 'PUT',
			body: emailContent
		})
		if (res.ok) {
			return res
		} else {
			logtail({
				env, ctx, msg: `Failed to save to B2! ${res.status} - ${res.statusText}`,
				level: LogLevel.Warning,
				data: {
					b2Key,
					subject,
					to: message.to,
					from: message.from,
					emailLength: emailContent.toString().length,
					res: {
						status: res.status,
						statusText: res.statusText,
						body: await res.text()
					}
				}
			})
		}
	}

	const sendDiscordEmbed = async () => pRetry(async () => await env.DISCORDEMBED.send({
		from: message.from,
		subject: subject,
		to: message.to,
		r2path: b2Key,
		ts: dt.getTime(),
		shouldCheckGovDelivery,
	}), {
		retries: 5, minTimeout: 250, onFailedAttempt: async (e) => {
			if (e.retriesLeft === 0) {
				logtail({
					env, ctx, e, msg: 'Failed to send to Queue, giving up: ' + e.message,
					level: LogLevel.Error,
					data: {
						queue: 'DISCORDEMBED',
						attemptNumber: e.attemptNumber,
						retriesLeft: e.retriesLeft,
						b2Key,
						subject,
						to: message.to,
						from: message.from,
						emailLength: emailContent.toString().length,
					}
				})
			} else {
				logtail({
					env, ctx, e, msg: 'Failed to send to Queue, retrying: ' + e.message,
					level: LogLevel.Error,
					data: {
						queue: 'DISCORDEMBED',
						attemptNumber: e.attemptNumber,
						retriesLeft: e.retriesLeft,
						b2Key,
						subject,
						to: message.to,
						from: message.from,
						emailLength: emailContent.toString().length,
					}
				})
				if (e.message.includes('Queue is overloaded. Please back off.')) {
					await scheduler.wait(1000 * e.attemptNumber)
				}
			}
		}
	})

	await Promise.allSettled([putR2(), putB2()])
	await sendDiscordEmbed()
}
