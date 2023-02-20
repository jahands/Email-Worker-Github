import { ThrottledQueue } from '@jahands/msc-utils'
import { AwsClient } from 'aws4fetch'
import sanitize from 'sanitize-filename';

import { QueueData, Env } from "./types";

const AETYPES = {
	Msc: 'msc',
	Github: 'github',
	Disqus: 'disqus',
	Blogtrottr: 'blogtrottr'
} as const

const throttleQueue = new ThrottledQueue({ concurrency: 1, interval: 5000, limit: 5 });

export default {
	async email(message: EmailMessage, env: Env, ctx: ExecutionContext) {
		const now = Date.now()
		let allAEType: string = AETYPES.Msc
		const subject = message.headers.get('subject') || ''
		await env.QUEUE.send({
			ts: now,
			from: message.from,
			to: message.to,
			subject: subject
		})
		if (['noreply@github.com',
			'notifications@github.com'].includes(message.from)) {
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
					const res = await saveEmailToB2(env, message, `github/${message.from}/${org}/${project}`, now)
					console.log({ status: res.status })
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
			}

			const folder = `to/${message.to}/from/${from}`
			const res = await saveEmailToB2(env, message, folder, now)
			console.log({ status: res.status })
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
	},

	async queue(batch: MessageBatch<QueueData>, env: Env) {
		// Extract the body from each message.
		// Metadata is also available, such as a message id and timestamp.
		const messages: QueueData[] = batch.messages.map((msg) => msg.body)
		// for (const msg of messages) {
		// 	throttleQueue.add(() => sendHook(`**To:** ${msg.to} • **From:** ${msg.from} • <t:${Math.round(msg.ts / 1000)}:f>\n**Subject:** ${msg.subject}`, env))
		// }
		const content = messages.map(msg => `**To:** ${msg.to} • **From:** ${msg.from} • <t:${Math.round(msg.ts / 1000)}:f>\n**Subject:** ${msg.subject}`)
		let next = ''
		for (let i = 0; i < content.length; i++) {
			if (next.length + content[i].length >= 1990) {
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
	},
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

function formatDate(dt: Date, ops: { hour: boolean } = { hour: true }): string {
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

function fixFilename(s: string): string {
	return sanitize(s).
		replace("`", "''").
		replace('/', '_').
		replace('\\', '_').
		replace('’', '')
}

async function saveEmailToB2(env: Env, message: EmailMessage, folder: string, now: number): Promise<Response> {
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
	filename = trimChar(filename, '-').trim()
	filename = trimChar(filename, '_').trim()
	if (!filename || filename === '') {
		filename = `NOSUBJECT_${crypto.randomUUID()}`
	}
	const suffix = `.${now}.eml`
	// Max length of a file on linux is 255, so we want to limit the last
	// segment length. Went with 254 because off-by-one is annoying
	const filenameWithSuffixLength = `${filename}${suffix}`.length
	if (filenameWithSuffixLength > 254) {
		const amountToTrim = 254 - suffix.length
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
	try {
		await env.R2.put(b2Key, emailContent, {
			customMetadata: {
				to: message.to,
				from: message.from,
				subject: subject
			}
		})
	} catch (e) {
		console.log('failed to save to R2', e)
	}
	return await aws.fetch(`${env.B2_ENDPOINT}/${encodeURIComponent(b2Key)}`, {
		method: 'PUT',
		body: emailContent
	})
}

function trimChar(str: string, ch: string) {
	var start = 0,
		end = str.length;
	while (start < end && str[start] === ch)
		++start;
	while (end > start && str[end - 1] === ch)
		--end;
	return (start > 0 || end < str.length) ? str.substring(start, end) : str;
}
