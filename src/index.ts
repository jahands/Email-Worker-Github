/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `wrangler dev src/index.ts` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `wrangler publish src/index.ts --name my-worker` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { EmailMessage, Env } from "./types";


export default {
	async email(message: any, env: Env, ctx: ExecutionContext) {
		await env.QUEUE.send({
			ts: Date.now(),
			from: message.from,
			subject: message.headers.get('subject')
		})
		if (message.from.includes('github.com') && message.headers.get('subject').includes('Please verify your email address.')) {
			await message.forward("jacob@jacobhands.com");
		}
	},

	async queue(batch: MessageBatch<EmailMessage>, env: Env) {
		// Extract the body from each message.
		// Metadata is also available, such as a message id and timestamp.
		const messages: EmailMessage[] = batch.messages.map((msg) => msg.body)
		const content = messages.map(msg => `**From:** ${msg.from} • <t:${msg.ts}:R>\n**Subject:** ${msg.subject}`)
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
	await fetch(env.DISCORDHOOK, {
		body: content,
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		}
	})
}