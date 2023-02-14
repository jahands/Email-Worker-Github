import { EmailMessage, Env } from "./types";

export default {
	async email(message: any, env: Env, ctx: ExecutionContext) {
		const subject = message.headers.get('subject')
		await env.QUEUE.send({
			ts: Date.now(),
			from: message.from,
			subject: subject
		})
		if (['noreply@github.com',
			'notifications@github.com'].includes(message.from)) {
			// Write some stats to AE
			try {
				const { org, project } = getProjectInfo(subject)
				env.STATS.writeDataPoint({
					blobs: ['Org'],
					doubles: [1],
					indexes: [org]
				})
				env.STATS.writeDataPoint({
					blobs: ['Project'],
					doubles: [1],
					indexes: [project]
				})
			} catch (e) {
				console.log(`Unable to find project info in: ${subject}\n${e}`)
			}
		}
		if (message.from.includes('github.com') && message.headers.get('subject').includes('Please verify your email address.')) {
			await message.forward("jacob@jacobhands.com");
		}
	},

	async queue(batch: MessageBatch<EmailMessage>, env: Env) {
		// Extract the body from each message.
		// Metadata is also available, such as a message id and timestamp.
		const messages: EmailMessage[] = batch.messages.map((msg) => msg.body)
		const content = messages.map(msg => `**From:** ${msg.from} • <t:${Math.round(msg.ts / 1000)}:f>\n**Subject:** ${msg.subject}`)
		let next = ''
		for (let i = 0; i < content.length; i++) {
			if (next.length + content[i].length >= 1990) {
				await sendHook(next, env)
				next = ''
			} else {
				next += `\n${content[i]}`
			}
		}
		if (next.length > 0) {
			await sendHook(next, env)
		}
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